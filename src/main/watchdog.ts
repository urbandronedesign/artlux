// Unattended self-healing watchdog (Tier-1, in-process). For broadcast/show installs that run for
// days with nobody watching. It detects the ways a show goes dark — renderer crash, GPU-process
// crash, an unresponsive window, a frozen render loop (no heartbeat), and sustained Art-Net output
// loss — and recovers with a FULL, leak-safe process relaunch into the current --broadcast
// --project=… (the same clean-process pattern the playlist scheduler uses; see docs/SHOW-CONTROL.md).
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
import type { OutputStats, UnattendedPrefs, WatchdogEvent, WatchdogStatus } from '../../shared/protocol';

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
const RING_CAP = 500; // events kept in memory / on disk before trimming
const LOG_TRIM_AT = 2000; // rewrite the on-disk log once it exceeds this many lines

let cfg: UnattendedPrefs = { ...WATCHDOG_DEFAULTS };
let mode = 'editor';
let project = '';
let armed = false; // enabled && (broadcast || always) — set once at start()
let relaunching = false; // in-process guard: once we decide to relaunch, ignore further triggers
let healthTimer: ReturnType<typeof setInterval> | null = null;
let lastRenderAt = 0; // epoch ms of the last renderer heartbeat (0 until the first one)
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
}

// ─── Detection ────────────────────────────────────────────────────────────────────────────────

function healthTick(): void {
  if (!armed || relaunching) return;
  try {
    const now = Date.now();
    // Frozen render loop: the tick stopped pushing heartbeats. Catches WebGPU/JS stalls inside the
    // compositor that never fire 'unresponsive' (e.g. a device-lost spin). Only after the first beat.
    if (cfg.crashRecovery && lastRenderAt > 0 && now - lastRenderAt > cfg.renderStallSec * 1000) {
      maybeRelaunch('render-stall', `no render heartbeat ${Math.round((now - lastRenderAt) / 1000)}s`);
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
    if (existsSync(trippedFlag())) { logEvent(trigger, detail, 'skipped-tripped', 'breaker engaged'); return; }
    const recent = pruneRelaunchTimes();
    if (recent.length >= cfg.maxRelaunchesPerHour) {
      try { writeFileSync(trippedFlag(), new Date().toISOString(), 'utf-8'); } catch { /* ignore */ }
      logEvent(trigger, `${detail}; ${recent.length} relaunches/h`, 'tripped', 'circuit breaker — giving up');
      return;
    }
    relaunching = true;
    recent.push(Date.now());
    saveRelaunchTimes(recent);
    logEvent(trigger, detail, 'relaunch', 'ok');

    // Mirror the proven relaunch pattern (index.ts APP_RELAUNCH_BROADCAST / scheduler.ts): re-pass the
    // app path when unpacked or Electron relaunches with no app; carry the current project forward.
    const args = app.isPackaged ? [] : [app.getAppPath()];
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
