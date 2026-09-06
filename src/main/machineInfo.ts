// WHAT THIS MACHINE IS — and, far more usefully, WHAT CHANGED ON IT.
//
// Most venue regressions are environmental, not code. A GPU driver updated itself overnight; a
// projector was replugged and Windows renumbered the displays, silently breaking an output binding; a
// native addon did not ship in this install. None of that is visible from the app's own behaviour, and
// none of it was recorded anywhere — so "it worked last week" had no evidence attached to it.
//
// TWO RECORDS, AND THE SECOND IS THE VALUABLE ONE.
//   · `config.snapshot` — the full picture, once per boot, before any project loads. Deliberately
//     before: a machine that cannot open a project still leaves a record of what it IS, which is
//     exactly the case where you are furthest from an answer.
//   · `config.changed` — emitted ONLY when the diff against the last boot is non-empty, naming just
//     the fields that moved. One line, at warn, and nothing at all on a machine that did not change.
//     This is the record that answers "what changed since the last time it worked?".
//
// The install id is a random UUID, NOT derived from hardware. It identifies the install just as well,
// survives a NIC or disk change (which a hardware id would report as a different machine), and carries
// no fingerprint.
//
// The renderer's half arrives late and separately: the WebGPU adapter is only knowable once a window
// exists, so boot does not wait for it. `noteRendererGpu` folds it in when it comes, diffs it then, and
// re-persists — which is what makes "this machine silently fell back to WebGL" a thing the log catches.
// That matters because the venue policy is that WebGPU is required; the WebGL path is for building
// scenes, not for running a show.

import { app, screen } from 'electron';
import { existsSync, readFileSync, writeFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, cpus, totalmem, freemem, platform, release, version, arch, uptime, networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';
import * as logger from './logger';
import * as bootReport from './bootReport';
import * as persistence from './persistence';

const installFile = () => join(app.getPath('userData'), 'artlux-install.json');
const stateFile = () => join(app.getPath('userData'), 'artlux-machine.json');

/** The renderer's WebGPU report, folded in when it arrives (see noteRendererGpu). */
export interface RendererGpuInfo {
  backend?: string;             // 'webgpu' | 'webgl'
  fellBackToWebGL?: boolean;
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

let last: Record<string, unknown> | null = null; // the snapshot we persisted, for diffing

// ── Install identity ──────────────────────────────────────────────────────────────────────────

/** A stable, random, per-install id. Created on first run and never regenerated. */
export function installId(): string {
  try {
    const f = installFile();
    if (existsSync(f)) {
      const parsed = JSON.parse(readFileSync(f, 'utf-8')) as { id?: string };
      if (parsed?.id) return parsed.id;
    }
    const id = randomUUID();
    writeFileSync(f, JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2), 'utf-8');
    return id;
  } catch {
    return 'unknown';
  }
}

// ── Collection ────────────────────────────────────────────────────────────────────────────────

function freeMB(path: string): number | null {
  try {
    const st = statfsSync(path);
    return Math.round((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
  } catch { return null; }
}

/**
 * GPU vendor / device / driver, from Chromium's own probe.
 *
 * 'complete' rather than 'basic' because the DRIVER VERSION only appears in the complete report, and
 * the driver version is the single field this whole module most exists to capture. It can reject or
 * hang on a broken driver, so it is raced against a timeout rather than awaited unconditionally — a
 * machine with a sick GPU is precisely one that must still finish booting and still write a log.
 */
async function gpuInfo(): Promise<Record<string, unknown>> {
  try {
    const info = await Promise.race([
      app.getGPUInfo('complete') as Promise<Record<string, unknown>>,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    if (!info) return { probe: 'timeout' };
    // EVERY adapter, not just gpuDevice[0]. A venue PC and most laptops have two — the integrated one
    // and the discrete one — and on this project the discrete card is the interesting one: it decides
    // whether NVAPI scanout warp is available at all. Reporting only the first would describe the Intel
    // chip on a machine whose show runs on the RTX beside it.
    const devices = ((info as { gpuDevice?: Array<Record<string, unknown>> }).gpuDevice || []).map((d) => ({
      vendorId: d.vendorId ?? null,
      deviceId: d.deviceId ?? null,
      driverVersion: d.driverVersion ?? null,
      driverVendor: d.driverVendor ?? null,
      active: d.active ?? null,
      description: d.deviceString ?? null,
    }));
    const primary = devices.find((d) => d.active) || devices[0] || {};
    const aux = info as { auxAttributes?: Record<string, unknown> };
    return {
      ...primary,
      adapters: devices.length,
      ...(devices.length > 1 ? { devices } : {}),
      device: aux.auxAttributes?.glRenderer ?? null,
      vendor: aux.auxAttributes?.glVendor ?? null,
    };
  } catch {
    return { probe: 'failed' };
  }
}

/**
 * Display topology. Same shape `projector.ts` builds for the outputs UI, rebuilt here rather than
 * imported so this module has no dependency on the projector subsystem (it must work in headless,
 * where no projector window is ever registered).
 *
 * `id` is included precisely BECAUSE it is unstable — a replug renumbers it, an output binding then
 * points at a display that no longer exists, and the operator sees a dead output with no explanation.
 * Recording it turns that into a one-line diff.
 */
function displays(): Array<Record<string, unknown>> {
  try {
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      label: d.label || '',
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      // The specs a PROJECTION app is actually judged on. Refresh rate especially: a projector locked
      // to 60 Hz beside a 144 Hz monitor explains a whole class of "it looks different on that output",
      // and rotation explains a warp that looks mirrored.
      hz: d.displayFrequency ?? null,
      colorDepth: d.colorDepth ?? null,
      rotation: d.rotation ?? 0,
      primary: d.id === primaryId,
      internal: d.internal,
    }));
  } catch { return []; }
}

/**
 * The interfaces Art-Net, sACN, NDI and OSC can bind to.
 *
 * A venue's most common network fault is binding to the wrong NIC — output leaves on the office
 * adapter instead of the lighting one, and nothing anywhere says so. The list of what WAS available,
 * captured at boot, is what makes that diagnosable after the fact.
 *
 * ⚠ These are LAN addresses. They stay in the log because the log is read on the machine that wrote
 * it (plans/machine-logging.md §11) — but this is the field to think about before sending one on.
 */
function nics(): Array<Record<string, unknown>> {
  try {
    const out: Array<Record<string, unknown>> = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.internal || a.family !== 'IPv4') continue;
        out.push({ name, address: a.address, mac: a.mac, cidr: a.cidr ?? null });
      }
    }
    return out;
  } catch { return []; }
}

/** The prefs that change how this machine BEHAVES — not the whole blob, which is mostly UI state. */
function behaviourPrefs(): Record<string, unknown> {
  try {
    const p = persistence.getPrefs() as unknown as Record<string, unknown>;
    const settings = (p.appSettings || {}) as Record<string, unknown>;
    return {
      engineRateHz: settings.engineRateHz ?? null,
      scene3dRenderScale: p.scene3dRenderScale ?? null,
      scene3dMaxFps: p.scene3dMaxFps ?? null,
      dockingOff: (p.layoutState as { dockingOff?: boolean } | undefined)?.dockingOff ?? null,
      unattendedEnabled: (p.unattended as { enabled?: boolean } | undefined)?.enabled ?? false,
      calibrationFile: p.calibrationFile ?? null,
      uiScale: p.uiScale ?? null,
      showSplash: p.showSplash !== false,
    };
  } catch { return {}; }
}

/** Natives and plugin halves, with the load duration bootReport already measured. */
function modules(): Array<Record<string, unknown>> {
  try {
    return bootReport.get().entries.map((e) => ({ id: e.id, group: e.group, state: e.state, ms: e.ms ?? null }));
  } catch { return []; }
}

async function collect(): Promise<Record<string, unknown>> {
  const cpuList = (() => { try { return cpus(); } catch { return []; } })();
  return {
    app: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome },
    machine: (() => { try { return hostname(); } catch { return 'unknown'; } })(),
    install: installId(),
    os: {
      platform: platform(),
      release: release(),
      // `release()` is a build number ("10.0.26200"); `version()` is the name a human recognises
      // ("Windows 11 Pro"). Both, because the build number is what a driver or OS bug is filed against.
      name: (() => { try { return version(); } catch { return null; } })(),
      arch: arch(),                       // x64 vs arm64 decides whether the six native addons load at all
      uptimeHours: Math.round(uptime() / 360) / 10,
      // The scheduler and the playlist are WALL-CLOCK driven, so a machine in the wrong timezone runs
      // the right show at the wrong hour — a fault with no other symptom in any log.
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })(),
      locale: (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return null; } })(),
    },
    cpu: { model: cpuList[0]?.model ?? null, cores: cpuList.length, speedMHz: cpuList[0]?.speed ?? null, arch: arch() },
    memory: { totalMB: Math.round(totalmem() / (1024 * 1024)), freeMB: Math.round(freemem() / (1024 * 1024)) },
    network: nics(),
    gpu: await gpuInfo(),
    displays: displays(),
    modules: modules(),
    prefs: behaviourPrefs(),
    disk: { userDataFreeMB: freeMB(app.getPath('userData')) },
  };
}

// ── Diffing ───────────────────────────────────────────────────────────────────────────────────

/**
 * Flatten to dotted paths so the diff names a FIELD rather than reporting "displays changed".
 *
 * Arrays are indexed (`displays.2.id`) rather than compared as wholes, because the useful answer is
 * "display 2's id moved", not "the display list is different".
 */
function flatten(v: unknown, prefix: string, out: Record<string, unknown>): void {
  if (v === null || typeof v !== 'object') { out[prefix] = v; return; }
  if (Array.isArray(v)) { v.forEach((x, i) => flatten(x, `${prefix}.${i}`, out)); return; }
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    flatten(val, prefix ? `${prefix}.${k}` : k, out);
  }
}

/** Fields that legitimately differ every boot and would drown the signal. */
const VOLATILE = /(^|\.)(disk\.|modules\.\d+\.ms$)/;

function diff(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  flatten(prev, '', a);
  flatten(next, '', b);
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (VOLATILE.test(key)) continue;
    if (a[key] === b[key]) continue;
    out[key] = [a[key] ?? null, b[key] ?? null];
  }
  return out;
}

function persist(snap: Record<string, unknown>): void {
  try { writeFileSync(stateFile(), JSON.stringify(snap), 'utf-8'); } catch { /* ignore */ }
}

function loadPrevious(): Record<string, unknown> | null {
  try {
    const f = stateFile();
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf-8')) as Record<string, unknown>;
  } catch { return null; }
}

// ── Public API ────────────────────────────────────────────────────────────────────────────────

/**
 * Collect and log the boot snapshot, then the diff against the previous boot.
 *
 * Called after the main plugins have reported (so `modules` is populated) and never awaited by the
 * boot path — a slow GPU probe must not delay a window.
 */
export async function emitBoot(): Promise<void> {
  try {
    const snap = await collect();
    logger.log('info', 'config', 'config.snapshot', snap);
    const prev = loadPrevious();
    if (prev) {
      const changes = diff(prev, snap);
      const keys = Object.keys(changes);
      // At `warn` on purpose: this is the line you want to catch your eye when scanning a venue log,
      // and it appears only when the machine genuinely moved under the app.
      if (keys.length) logger.log('warn', 'config', 'config.changed', { count: keys.length, ...changes });
    }
    last = snap;
    persist(snap);
  } catch (e) {
    logger.log('warn', 'config', 'config.error', undefined, e);
  }
}

/**
 * Fold in the renderer's WebGPU report once a window has one, diff that subtree, and re-persist.
 *
 * Separate from the boot snapshot because an adapter is only knowable after a window exists, and boot
 * must not wait on one. `fellBackToWebGL` is logged at warn independently of the diff: on a venue
 * machine that is a fault, not a configuration detail, and it should say so on the FIRST boot it
 * happens rather than only when it changes.
 */
export function noteRendererGpu(info: RendererGpuInfo): void {
  try {
    logger.log('info', 'config', 'config.gpu', { ...info });
    if (info.fellBackToWebGL) {
      logger.log('warn', 'config', 'gpu.fallback', {
        reason: 'WebGPU unavailable — running the WebGL fallback',
        adapter: info.device || info.description || null,
      });
    }
    if (!last) return;
    const prevGpu = (loadPrevious()?.webgpu ?? null) as Record<string, unknown> | null;
    const merged = { ...last, webgpu: { ...info } };
    if (prevGpu) {
      const changes = diff({ webgpu: prevGpu }, { webgpu: info as unknown as Record<string, unknown> });
      const keys = Object.keys(changes);
      if (keys.length) logger.log('warn', 'config', 'config.changed', { count: keys.length, ...changes });
    }
    last = merged;
    persist(merged);
  } catch { /* ignore */ }
}
