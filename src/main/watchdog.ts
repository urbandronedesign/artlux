// Unattended self-healing watchdog (Tier-1, in-process). For broadcast/show installs that run for
// days with nobody watching. It detects the ways a show goes dark — renderer crash, GPU-process
// crash, an unresponsive window, a frozen render loop (no heartbeat), an uncaught renderer error
// (the WHITE SCREEN), and sustained Art-Net output loss — and recovers with a FULL, leak-safe process
// relaunch into the current --broadcast --project=… (the same clean-process pattern the playlist
// scheduler uses; see docs/SHOW-CONTROL.md).
//
// The white screen is the subtle one and the reason for noteRendererFault + noteRendererUp below: a
// React render throw unmounts the whole tree but leaves the process ALIVE and RESPONSIVE, so four of
// the five detectors are structurally blind to it, and the fifth (render-stall) was gated on a
// heartbeat that a LOAD-PATH throw never produces. A poisoned project file used to mean an install
// that was dead, silent and invisible to every tier, forever. See services/faultReporter.ts.
//
// Why a relaunch and not a reload: applyProjectData has no teardown for media-cache blob URLs /
// decode pools / undo history, so a fresh process each recovery avoids accumulated leaks — exactly
// the trade-off the show scheduler already makes.
//
// A crash-loop CIRCUIT BREAKER caps relaunches to maxRelaunchesPerHour: past that it writes a
// tripped marker in userData and STOPS relaunching (leaving the show down beats an infinite storm).
// The Tier-2 Scheduled Task (scripts/watchdog-check.ps1) honors the same marker so it stands down too.
//
// Everything here graceful-degrades: any failure logs and is swallowed — the watchdog must never be
// the thing that takes the app down. It is armed only when Prefs.unattended.enabled is set AND the
// process is in --broadcast (or unattended.always), so a developer pausing on a breakpoint in the
// editor never triggers an auto-relaunch. Config/marker/log all live in app.getPath('userData').

import { app, type BrowserWindow } from 'electron';
import { appendFileSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { OutputStats, RendererFault, UnattendedPrefs, WatchdogEvent, WatchdogStatus } from '../../shared/protocol';
import { relaunchArgs } from './runProfile';

export const WATCHDOG_DEFAULTS: UnattendedPrefs = {
  enabled: false,
  crashRecovery: true,
  outputDownSec: 15,
  renderStallSec: 10,
  minRelaunchGapSec: 30,
  maxRelaunchesPerHour: 6,
};

const TASK_NAME = 'ArtLux Watchdog';
const HOUR_MS = 3_600_000;
// How long a freshly-loaded document may take to produce its FIRST heartbeat before we call it dead.
// Deliberately not renderStallSec: that pref answers "the frame loop froze mid-show", where 10 s is
// generous. First paint in broadcast is a different question — plugin activation, a project read off
// a cold network share, a first-run shader compile — and re-using the same 10 s would relaunch a
// merely-slow venue into a loop that trips the breaker. A floor, not a replacement: an operator who
// raises renderStallSec raises this with it.
const BOOT_GRACE_FLOOR_SEC = 30;
const RING_CAP = 500; // events kept in memory / on disk before trimming
const LOG_TRIM_AT = 2000; // rewrite the on-disk log once it exceeds this many lines

let cfg: UnattendedPrefs = { ...WATCHDOG_DEFAULTS };
let mode = 'editor';
let project = '';
let armed = false; // enabled && (broadcast || always) — set once at start()
let relaunching = false; // in-process guard: once we decide to relaunch, ignore further triggers
let deferTimer: ReturnType<typeof setTimeout> | null = null; // pending paced relaunch (minRelaunchGapSec)
let trippedNoted = false; // breaker refusal logged once this process (a persistent fault re-fires at 1 Hz)
let healthTimer: ReturnType<typeof setInterval> | null = null;
let lastRenderAt = 0; // epoch ms of the last renderer heartbeat, or of the document load that owes us the first one
let awaitingFirstBeat = false; // true between did-finish-load and the first heartbeat (→ the longer boot grace)
let everUp = false; // output was live at least once (so "down" means it died, not never-configured)
let outputDownSince: number | null = null;
let ring: WatchdogEvent[] = []; // chronological; tail of the persistent log
let onEvent: ((e: WatchdogEvent) => void) | null = null;

const userData = () => app.getPath('userData');
const logFile = () => join(userData(), 'artlux-watchdog.log');
const stateFile = () => join(userData(), 'artlux-watchdog-state.json');
const trippedFlag = () => join(userData(), 'artlux-watchdog-tripped.flag');

// ─── Public lifecycle ───────────────────────────────────────────────────────────────────────────

export function start(opts: { mode: string; project: string; cfg?: Partial<UnattendedPrefs> }): void {
  try {
    mode = opts.mode || 'editor';
    project = opts.project || '';
    cfg = { ...WATCHDOG_DEFAULTS, ...(opts.cfg ?? {}) };
    armed = !!cfg.enabled && (mode === 'broadcast' || !!cfg.always);
    loadRing();

    // Storm subsided (no relaunches in the last hour) → clear a stale breaker so a stable restart
    // gets a clean slate. A persistent fault that restarts within the hour stays tripped.
    if (pruneRelaunchTimes().length === 0 && existsSync(trippedFlag())) {
      try { unlinkSync(trippedFlag()); } catch { /* ignore */ }
    }

    if (!armed) return;
    logEvent('startup', `mode=${mode}`, 'none', 'watching');

    // GPU-process crash is an app-level event (not per-webContents). WebGPU device loss is the classic
    // silent show-killer, so a hard GPU crash triggers recovery.
    if (cfg.crashRecovery) {
      app.on('child-process-gone', (_e, details) => {
        if (details?.type === 'GPU' && details?.reason !== 'clean-exit') {
          maybeRelaunch('gpu-gone', `reason=${details?.reason ?? 'unknown'}`);
        }
      });
    }

    healthTimer = setInterval(healthTick, 1000);
  } catch (e) {
    console.error('[watchdog] start failed', e);
  }
}

// Attach the per-window crash/hang detectors. Called from createWindow with the main window.
export function attach(win: BrowserWindow): void {
  if (!armed || !cfg.crashRecovery) return;
  try {
    win.webContents.on('render-process-gone', (_e, details) => {
      const reason = details?.reason ?? 'unknown';
      if (reason === 'clean-exit') return; // an intentional teardown, not a crash
      maybeRelaunch('render-process-gone', `reason=${reason}`);
    });
    // 'unresponsive' can flap (a long GC pause), so give it a grace window before acting; 'responsive'
    // cancels it. This catches main-thread hangs the render-stall heartbeat may be slower to notice.
    let hangTimer: ReturnType<typeof setTimeout> | null = null;
    win.on('unresponsive', () => {
      if (hangTimer) return;
      hangTimer = setTimeout(() => maybeRelaunch('unresponsive', `unresponsive ${cfg.renderStallSec}s`), cfg.renderStallSec * 1000);
    });
    win.on('responsive', () => { if (hangTimer) { clearTimeout(hangTimer); hangTimer = null; } });
  } catch (e) {
    console.error('[watchdog] attach failed', e);
  }
}

export function stop(): void {
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; } // never fire a paced relaunch after a clean quit
}

// ─── Health feeds (called from the existing 1 Hz stat plumbing in ipc.ts) ─────────────────────────

export function noteEngineStats(stats: OutputStats | null): void {
  if (!armed) return;
  const fps = stats?.fps ?? 0;
  if (fps > 0) { everUp = true; outputDownSince = null; }
  else if (everUp && outputDownSince === null) outputDownSince = Date.now();
}

// The payload is unused — its mere arrival is the heartbeat that the renderer frame loop is alive.
export function noteRenderStats(_stats?: unknown): void {
  if (!armed) return;
  lastRenderAt = Date.now();
  awaitingFirstBeat = false; // the renderer painted: from here the tighter render-stall window applies
}

/**
 * The document finished loading — start the clock on its FIRST heartbeat.
 *
 * This is the fix for the blind spot. `render-stall` is gated on `lastRenderAt > 0`, and that value
 * only ever came from a heartbeat, which only ever comes from a mounted App. So a renderer that threw
 * on its very first render — a poisoned project file, i.e. the exact class of bug that ships — never
 * armed the one detector that could have seen it, and the install sat dead and silent forever.
 * Seeding the clock at 'did-finish-load' (which ALWAYS fires; main/index.ts already leans on that for
 * the reveal backstop) means a renderer that never paints stalls like one that stopped painting.
 *
 * This is belt to the fault reporter's braces, and it is the half that still works when the boundary,
 * the reporter or the preload bridge is itself what broke.
 */
export function noteRendererUp(): void {
  if (!armed) return;
  lastRenderAt = Date.now();
  awaitingFirstBeat = true;
}

/**
 * An uncaught renderer error, forwarded from ipc.ts. `from` is the SENDER's identity, not the
 * fault's self-description: a projector or docs window shares this channel and must never be able to
 * relaunch the show.
 */
export function noteRendererFault(f: RendererFault, from: 'main' | 'aux'): void {
  try {
    const who = `${from}/${f?.window ?? '?'}:${f?.scope ?? '?'}${f?.pluginId ? '/' + f.pluginId : ''}`;
    const when = f?.beforeFirstPaint ? ' (before first paint)' : '';
    // ALWAYS audit, even unarmed. With the watchdog off — the default, and every editor install —
    // this JSONL log in userData is the only durable record that the app white-screened at all.
    logEvent('renderer-fault', `${who}${when} ${f?.message ?? ''}`.trim(), 'none', 'reported');
    if (!armed || !cfg.crashRecovery) return;
    if (from !== 'main') return;        // a projector/docs fault is auditable, not a show failure
    // A CONTAINED region is not a dead show: the shell's panel boundaries keep Stage and the wire
    // running, and relaunching an operator's editor because one panel card appeared is its own kind
    // of unattended failure. Only a fault that took the root (or Stage, the frame source) is one.
    if (f?.scope !== 'root' && f?.scope !== 'stage') return;
    maybeRelaunch('renderer-fault', `${f.scope}: ${f.message ?? 'uncaught renderer error'}`);
  } catch (e) {
    console.error('[watchdog] noteRendererFault failed', e);
  }
}

// ─── Detection ────────────────────────────────────────────────────────────────────────────────

function healthTick(): void {
  if (!armed || relaunching) return;
  try {
    const now = Date.now();
    // Frozen render loop: the tick stopped pushing heartbeats. Catches WebGPU/JS stalls inside the
    // compositor that never fire 'unresponsive' (e.g. a device-lost spin) — AND, since noteRendererUp
    // seeds the clock at did-finish-load, a renderer that threw on its first render and so never
    // produced a beat at all. Those two deserve different patience, hence the boot grace.
    const stallMs = (awaitingFirstBeat ? Math.max(cfg.renderStallSec, BOOT_GRACE_FLOOR_SEC) : cfg.renderStallSec) * 1000;
    if (cfg.crashRecovery && lastRenderAt > 0 && now - lastRenderAt > stallMs) {
      const secs = Math.round((now - lastRenderAt) / 1000);
      maybeRelaunch('render-stall', awaitingFirstBeat
        ? `no first render heartbeat ${secs}s after load (boot grace ${Math.round(stallMs / 1000)}s)`
        : `no render heartbeat ${secs}s`);
      return;
    }
    // Sustained output loss after the wire was live. Keep-alive means the native pacer holds fps > 0
    // through a mere renderer stall, so this fires only on genuine engine/socket death.
    if (outputDownSince !== null && now - outputDownSince > cfg.outputDownSec * 1000) {
      maybeRelaunch('output-down', `output down ${Math.round((now - outputDownSince) / 1000)}s`);
    }
  } catch (e) {
    console.error('[watchdog] healthTick failed', e);
  }
}

// ─── Recovery + circuit breaker ─────────────────────────────────────────────────────────────────

function maybeRelaunch(trigger: string, detail: string): void {
  if (relaunching) return;
  try {
    // Refuse ONCE per process, not once per detection. healthTick re-fires render-stall EVERY SECOND
    // for as long as the fault persists, and a tripped breaker is by definition a fault that persists
    // — so logging each refusal appended a JSONL line per second, forever, and pushed a WATCHDOG_EVENT
    // to Preferences and the tablet metrics stream at the same rate. Found by running the real thing:
    // a poisoned renderer in broadcast tripped the breaker and then wrote 1 Hz of `skipped-tripped`
    // into a log that is only ever trimmed at BOOT — and a tripped install does not boot again. This
    // is the same trap the pacing branch below already guards with `if (deferTimer) return`.
    if (existsSync(trippedFlag())) {
      if (!trippedNoted) { trippedNoted = true; logEvent(trigger, detail, 'skipped-tripped', 'breaker engaged'); }
      return;
    }
    const recent = pruneRelaunchTimes();
    if (recent.length >= cfg.maxRelaunchesPerHour) {
      try { writeFileSync(trippedFlag(), new Date().toISOString(), 'utf-8'); } catch { /* ignore */ }
      // The trip itself is the record; the refusals that follow it in THIS process add nothing.
      trippedNoted = true;
      logEvent(trigger, `${detail}; ${recent.length} relaunches/h`, 'tripped', 'circuit breaker — giving up');
      return;
    }
    // Pace back-to-back relaunches by minRelaunchGapSec. The FIRST relaunch after a stable run has no
    // recent timestamp → gap check passes → instant recovery. Only a 2nd+ relaunch inside the gap is
    // paced, and we DEFER (not drop) so a one-shot crash trigger still recovers once the gap elapses.
    // Persisted relaunch times mean the gap is honored across processes (the crash-loop case), and the
    // `if (deferTimer) return` guard logs the pacing decision exactly ONCE per window (healthTick re-fires
    // render-stall every second — logging on each would flood the audit log + tablet view).
    const gapMs = Math.max(0, (cfg.minRelaunchGapSec ?? 0) * 1000);
    if (gapMs > 0 && recent.length > 0) {
      const last = Math.max(...recent);
      const wait = last + gapMs - Date.now();
      if (wait > 0) {
        if (deferTimer) return; // already pacing — do not stack a timer or re-log
        logEvent(trigger, detail, 'skipped-debounce', `pacing ${Math.round(wait / 1000)}s (gap ${cfg.minRelaunchGapSec}s)`);
        deferTimer = setTimeout(() => { deferTimer = null; maybeRelaunch(trigger, `${detail} (deferred)`); }, wait + 50);
        return;
      }
    }
    relaunching = true;
    recent.push(Date.now());
    saveRelaunchTimes(recent);
    logEvent(trigger, detail, 'relaunch', 'ok');

    // ONE relaunch argv builder for the whole app (runProfile.relaunchArgs): re-passes the app path
    // when unpacked, and carries --built-renderer so the successor does not inherit a dev-server URL
    // whose server this exit is about to kill. Carry the current project forward on top of it.
    const args = relaunchArgs();
    args.push('--broadcast');
    if (project) args.push(`--project=${project}`);
    console.log('[watchdog] relaunch →', trigger, detail);
    try { app.releaseSingleInstanceLock(); } catch { /* ignore */ } // let the fresh process reclaim the lock
    app.relaunch({ args });
    app.exit(0);
  } catch (e) {
    console.error('[watchdog] relaunch failed', e);
    relaunching = false;
  }
}

// ─── Persistent event log (JSONL, tail-on-boot so the previous run's "why" survives the relaunch) ──

function logEvent(trigger: string, detail: string, action: string, outcome: string): WatchdogEvent {
  const e: WatchdogEvent = { ts: Date.now(), mode, project, trigger, detail, action, outcome };
  ring.push(e);
  if (ring.length > RING_CAP) ring = ring.slice(-RING_CAP);
  try { appendFileSync(logFile(), JSON.stringify(e) + '\n', 'utf-8'); } catch { /* ignore */ }
  try { onEvent?.(e); } catch { /* ignore */ }
  return e;
}

function loadRing(): void {
  try {
    const lines = readFileSync(logFile(), 'utf-8').split('\n').filter(Boolean);
    const tail = lines.slice(-RING_CAP);
    ring = tail
      .map((l) => { try { return JSON.parse(l) as WatchdogEvent; } catch { return null; } })
      .filter((x): x is WatchdogEvent => !!x);
    if (lines.length > LOG_TRIM_AT) { try { writeFileSync(logFile(), tail.join('\n') + '\n', 'utf-8'); } catch { /* ignore */ } }
  } catch { ring = []; }
}

// Relaunch timestamps persist across processes so the breaker survives a crash loop.
function loadRelaunchTimes(): number[] {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf-8')) as { relaunches?: number[] };
    return Array.isArray(s.relaunches) ? s.relaunches : [];
  } catch { return []; }
}
function saveRelaunchTimes(times: number[]): void {
  try { writeFileSync(stateFile(), JSON.stringify({ relaunches: times }), 'utf-8'); } catch { /* ignore */ }
}
function pruneRelaunchTimes(): number[] {
  const cutoff = Date.now() - HOUR_MS;
  return loadRelaunchTimes().filter((t) => t > cutoff);
}

// ─── Status + audit surface ─────────────────────────────────────────────────────────────────────

export function status(): WatchdogStatus {
  return {
    enabled: armed,
    tripped: existsSync(trippedFlag()),
    relaunchesLastHour: pruneRelaunchTimes().length,
    taskInstalled: isTaskInstalled(),
    recent: [...ring].reverse().slice(0, 50),
  };
}

export function recentEvents(n = 20): WatchdogEvent[] {
  return [...ring].reverse().slice(0, n);
}

export function setEventListener(cb: ((e: WatchdogEvent) => void) | null): void {
  onEvent = cb;
}

// ─── Tier-2 OS supervisor (Windows Scheduled Task) ────────────────────────────────────────────────

function scriptsDir(): string {
  const packaged = join(process.resourcesPath || '', 'scripts');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  return join(app.getAppPath(), 'scripts');
}

function isTaskInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  try { execFileSync('schtasks', ['/query', '/tn', TASK_NAME], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

// The .ps1 self-elevates (re-launches itself via RunAs) — registering a logon+repeat task needs admin.
// We just spawn it detached and return; the UAC prompt is the user's to approve.
function runTaskScript(name: string, extraArgs: string[]): { ok: boolean; message: string } {
  if (process.platform !== 'win32') return { ok: false, message: 'The OS watchdog task is Windows-only.' };
  try {
    const script = join(scriptsDir(), name);
    if (!existsSync(script)) return { ok: false, message: `Script not found: ${script}` };
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs],
      { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: 'Approve the elevation prompt to update the ArtLux Watchdog task.' };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message ?? e) };
  }
}

export function installTask(): { ok: boolean; message: string } {
  return runTaskScript('install-watchdog-task.ps1', ['-Exe', process.execPath, '-Project', project || '']);
}

export function uninstallTask(): { ok: boolean; message: string } {
  // Uninstalling is also the operator's "clean up + reset" — clear a tripped breaker so a future
  // re-enable starts fresh.
  try { if (existsSync(trippedFlag())) unlinkSync(trippedFlag()); } catch { /* ignore */ }
  return runTaskScript('uninstall-watchdog-task.ps1', []);
}
