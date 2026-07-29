// The renderer's FAULT REPORTING path — the half of crash containment an ErrorBoundary does not give
// you, and the reason the watchdog could not see a white screen.
//
// THE FAILURE THIS EXISTS FOR. React 19 unmounts the entire root on an uncaught render throw. What is
// left is an empty <div id="root"> over a black window — and a process that is ALIVE, RESPONSIVE, and
// still turning its event loop. Of the watchdog's five detectors (src/main/watchdog.ts), four are
// structurally blind to that: 'render-process-gone' (the process did not die), 'unresponsive' (an
// unmounted tree is perfectly responsive), 'child-process-gone' (the GPU is fine), and 'output-down'
// (the native pacer's keep-alive holds fps > 0 with no renderer at all). Only 'render-stall' can see
// it — and only MID-SHOW, because it is gated on `lastRenderAt > 0`, i.e. on a heartbeat that a
// load-path throw never produces. A bad project file therefore used to yield an unattended install
// that was dead, silent, and invisible to every tier, forever. Nobody drives to the venue, because
// nothing ever alarmed.
//
// So: report the throw to the only process that can relaunch. Everything here graceful-degrades in
// the house style — every path swallows. This module must never be the thing that takes the renderer
// down, because it only ever runs when something already has.
//
// It imports NOTHING from React or App, so it can be the first import in every entry (before
// createRoot) and can be called from a boundary whose tree is mid-collapse.

import type { RendererFault } from '../../../shared/protocol';

export type FaultWindow = RendererFault['window'];

// ── Mode, read straight from the URL ──────────────────────────────────────────────────────────
// Deliberately NOT imported from App: App is exactly the module that may be failing to load. These
// mirror App.tsx's own BROADCAST/HEADLESS consts (same query flags, set by main/index.ts).
const QS = new URLSearchParams(window.location.search);
/** Broadcast or headless: an unattended run with nobody in the room. */
export const SHOW_ENGINE = QS.get('broadcast') === '1' || QS.get('headless') === '1';
/** `?safe=1` — this window is a Safe-Mode boot: skip the autoload that killed the last one. */
export const SAFE_MODE = QS.get('safe') === '1';

// ── Fault reporting ───────────────────────────────────────────────────────────────────────────

let currentProject = '';
let painted = false;

/** App tells us which document is loaded, so a fault names the file that poisoned it. */
export function setFaultProject(path: string | null | undefined): void { currentProject = path || ''; }

/**
 * Has this window ever produced a frame? Separates "this document cannot load" (a boot failure —
 * reloading it will throw again) from "it ran and then broke" (a reload is a real fix).
 */
export function hasPainted(): boolean { return painted; }

/**
 * The renderer produced a frame. Clears the Safe-Mode boot-failure breaker (this boot was healthy)
 * and marks later faults as post-paint — the difference between "this project cannot load" and "the
 * show broke after running fine", which is the difference between rung 3 and rung 2.
 */
export function notePainted(): void {
  if (painted) return;
  painted = true;
  clearBootFailures();
}

// Rate limit. A throwing rAF caught by the global net can fire at 60 Hz, and every report is a line
// in the watchdog's on-disk JSONL log. Cap per scope per session AND enforce a floor between
// identical reports — the latter also absorbs StrictMode's dev double-invoke, which would otherwise
// look like a loop (and double-count the boot breaker).
const MAX_PER_SCOPE = 5;
const REPEAT_FLOOR_MS = 1000;
const seen = new Map<string, { n: number; last: number }>();

export function reportFault(f: Omit<RendererFault, 'projectPath' | 'beforeFirstPaint'>): void {
  try {
    const key = `${f.scope}|${f.pluginId ?? ''}|${f.message}`;
    const now = Date.now();
    const s = seen.get(key) ?? { n: 0, last: 0 };
    if (s.n >= MAX_PER_SCOPE || now - s.last < REPEAT_FLOOR_MS) { s.n++; s.last = now; seen.set(key, s); return; }
    s.n++; s.last = now; seen.set(key, s);
  } catch { /* ignore — never let bookkeeping stop a report */ }

  // Loud in the console first: in dev this is the line a developer reads, and it survives even if
  // the bridge below is the thing that is broken.
  try { console.error(`[fault] ${f.scope}${f.pluginId ? ' · ' + f.pluginId : ''}:`, f.message, f.stack ?? ''); } catch { /* ignore */ }
  try {
    window.artlux?.reportRendererFault?.({
      ...f,
      projectPath: currentProject,
      beforeFirstPaint: !painted,
      // Stacks can be enormous (a React component stack plus a JS stack); the log is append-only and
      // lives on a show machine's disk. First ~4 kB is plenty to identify a throw site.
      stack: f.stack ? String(f.stack).slice(0, 4096) : undefined,
    });
  } catch { /* ignore — the bridge is absent in a bare browser context */ }
}

/**
 * The global net: throws a React boundary structurally CANNOT see. Boundaries catch render,
 * lifecycle and constructors only — not effects' async callbacks, not setTimeout/rAF ticks, not
 * rejected promises. This renderer is full of exactly those (the heartbeat rAF, the projector frame
 * pump's promise chain, layoutStore's debounce, every cueBus subscriber), and each one can leave the
 * show dead with the tree still mounted. Call once per entry, BEFORE createRoot.
 */
export function installGlobalNet(win: FaultWindow): void {
  try {
    window.addEventListener('error', (e) => {
      reportFault({ window: win, scope: 'global-error', message: e.message || 'uncaught error', stack: e.error?.stack });
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason as Error | undefined;
      reportFault({ window: win, scope: 'unhandled-rejection', message: r?.message ?? String(r ?? 'unhandled rejection'), stack: r?.stack });
    });
  } catch { /* ignore */ }
}

// ── The boot-failure breaker (renderer side) ──────────────────────────────────────────────────
// Rung 2 of the recovery ladder reloads the window. Without a counter that is a remount storm the
// MAIN-side breaker never sees, because that one counts process relaunches, not page loads.
//
// sessionStorage, deliberately: it survives a reload (which is exactly a boot attempt) and dies with
// the process. localStorage would leak a stale trip into an unrelated session weeks later and boot a
// healthy install into Safe Mode; prefs would need an IPC round-trip on the failing path.

const BOOT_KEY = 'artlux.bootFailures';
let recordedThisLoad = false;

interface BootFailures { path: string; n: number }

function readBootFailures(): BootFailures {
  try {
    const raw = sessionStorage.getItem(BOOT_KEY);
    if (!raw) return { path: '', n: 0 };
    const v = JSON.parse(raw) as Partial<BootFailures>;
    return { path: typeof v.path === 'string' ? v.path : '', n: typeof v.n === 'number' ? v.n : 0 };
  } catch { return { path: '', n: 0 }; }
}

/**
 * Count one failed boot for the current document. At most ONCE per page load, however many
 * boundaries fire — a throw that unmounts the root often trips several on the way out, and three
 * increments from one failure would skip straight past rung 2.
 */
export function noteBootFailure(): number {
  try {
    if (recordedThisLoad) return readBootFailures().n;
    recordedThisLoad = true;
    const prev = readBootFailures();
    // A different document means a different fault: start its count fresh.
    const n = (prev.path === currentProject ? prev.n : 0) + 1;
    sessionStorage.setItem(BOOT_KEY, JSON.stringify({ path: currentProject, n } satisfies BootFailures));
    return n;
  } catch { return 1; }
}

export function bootFailureCount(): number {
  const v = readBootFailures();
  return v.path === currentProject ? v.n : 0;
}

export function clearBootFailures(): void {
  try { sessionStorage.removeItem(BOOT_KEY); } catch { /* ignore */ }
}

// ── The recovery rungs a fallback can take ────────────────────────────────────────────────────

/** Rung 2: reload this window, same document. Keeps the query string (project, mode) intact. */
export function reloadWindow(): void {
  try { window.location.reload(); } catch { /* ignore */ }
}

/**
 * Rung 3 — THE ONLY RUNG THAT TERMINATES. Reload with `?safe=1`, which makes App skip the
 * `lastProjectPath`/`--project=` autoload and hydrate the default layout: a clean empty editor with a
 * banner, and the project file on disk untouched. We do NOT re-run applyProjectData in place (it has
 * no teardown — the same reason the watchdog relaunches instead of reloading) and we do not
 * synthesise an empty document in-tree; a reload buys a clean document AND a clean JS heap.
 */
export function safeBoot(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('safe', '1');
    window.location.replace(url.toString());
  } catch { reloadWindow(); }
}
