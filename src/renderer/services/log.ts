// THE RENDERER'S HALF OF THE MACHINE LOG — a batching client, and nothing else.
//
// Main is the single writer (see main/logger.ts for why). This module's whole job is to turn calls
// into records, gate them at the configured verbosity, and ship them across in BATCHES.
//
// THE BATCH IS THE POINT. One `.send` per record would put the IPC cost on the event rate; a 250 ms
// batch puts it on the CLOCK — four sends a second whether the operator is idle or busking as fast as
// a human can. Everything downstream is bounded the same way (main flushes once a second regardless),
// which is what makes the whole feature's cost defensible rather than hopeful.
//
// ⚠ NOTHING HERE MAY BE CALLED AT FRAME RATE. The frame loop runs at 30–60 Hz and touches every
// surface, fixture and universe; one line per frame is the floor, per-fixture is tens of thousands a
// second. `verify:invariants` guards the import: `renderer/engine/frameEngine.ts` and the render-free
// live channels (livePreview, dmxSignal, fixtureSignal, automationOverlay) must never import this.
// The rule generalises — SAMPLE RATES, LOG EDGES: a digest on a timer, an output-down transition
// rather than the 1 Hz sample, a starvation threshold crossing rather than a decode miss.
//
// Level gating happens HERE rather than in main, on purpose: it is cheaper at the source, and a record
// that fails the gate never touches the IPC bus at all. Operator actions therefore cost nothing at the
// venue default, because they live at 'debug' and the default floor is 'info'.
//
// Like faultReporter, this imports NOTHING from React or App and swallows on every path — it must be
// safe to call from a module that is still loading and from a tree that is mid-collapse.

import type { LogLevel, LogRecord, LoggingPrefs } from '../../../shared/protocol';
import { installConsoleTap } from '../../../shared/consoleTap';

// Lower is more severe; a record passes when its rank is <= the configured level's.
const RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const BATCH_MS = 250;   // the paced ship — four sends a second, whatever happens
const BATCH_AT = 128;   // …or this many records, whichever comes first
const QUEUE_CAP = 2048; // records held before we drop the OLDEST (main has its own, larger, cap)

// Records that must not wait for the tick. A crash loses whatever is still buffered, and these are
// exactly the ones you would want to have arrived.
const IMMEDIATE = /^(session\.|config\.|fault\.|open\.armed|gpu\.fallback)/;

// ── Which process is this? ────────────────────────────────────────────────────────────────────
// Read straight from the URL, deliberately NOT imported from App — App is exactly the module that may
// be failing to load when something wants to log. Mirrors faultReporter's reasoning.
// ⚠ `window` is guarded, not assumed. Several pure services (openTrace, dockTree, lookahead…) are
// imported by tsc-checked scripts that run under plain node — see DEVELOPMENT.md → Testing — and a
// module-scope `window.location` here would throw a ReferenceError on import, taking the script down
// for a reason that has nothing to do with what it was testing.
const HAS_WINDOW = typeof window !== 'undefined';
const QS = new URLSearchParams(HAS_WINDOW ? window.location.search : '');
const PROC: string = (() => {
  try {
    const surfaceId = QS.get('surfaceId');
    if (surfaceId) return `projector:${surfaceId}`;          // a per-surface fullscreen output window
    if (QS.get('headless') === '1') return 'headless';
    return HAS_WINDOW ? 'editor' : 'script';
  } catch { return 'editor'; }
})();

// ── State ─────────────────────────────────────────────────────────────────────────────────────

let level: LogLevel = 'info';
let categories: Record<string, LogLevel> = {};
let enabled = true;
let queue: LogRecord[] = [];
let dropped = 0;
let seq = 0;
let runId = '';
let timer: ReturnType<typeof setTimeout> | null = null;

const T0 = performance.now();
const up = (): number => Math.round(performance.now() - T0);

/**
 * Apply the machine's logging preferences. Called once App has read prefs; until then the defaults
 * ('info', enabled) apply — which is right, because the records emitted before that point are the
 * boot ones you would never want to lose to a configuration race.
 */
export function configure(prefs?: LoggingPrefs): void {
  enabled = prefs?.enabled !== false;
  level = prefs?.level ?? 'info';
  categories = { ...(prefs?.categories || {}) };
}

/** The correlation id every subsequent record carries. Minted per project open, alongside openTrace. */
export function setRun(id: string): void { runId = id; }

/** Cheap enough to call before building a payload — and callers SHOULD, when the payload costs anything. */
export function isEnabled(lv: LogLevel, cat: string): boolean {
  if (!enabled) return false;
  const override = categories[cat] ?? categories[cat.split(':')[0]!];
  return RANK[lv] <= RANK[override ?? level];
}

function emit(lv: LogLevel, cat: string, ev: string, d?: Record<string, unknown>, err?: unknown): void {
  if (!isEnabled(lv, cat)) return;
  try {
    const r: LogRecord = {
      t: new Date().toISOString(),
      up: up(),
      lv,
      cat,
      ev,
      proc: PROC,
      seq: seq++,
      ...(runId ? { run: runId } : {}),
      ...(d ? { d } : {}),
    };
    if (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      r.err = { message: e.message, ...(e.stack ? { stack: e.stack } : {}) };
    }
    // Drop the OLDEST under pressure: when a burst overruns the ship, what is happening NOW explains
    // more than how it began. The loss is surfaced rather than swallowed — see flush().
    if (queue.length >= QUEUE_CAP) { queue.shift(); dropped++; }
    queue.push(r);
    if (queue.length >= BATCH_AT || IMMEDIATE.test(ev) || lv === 'error') flush();
    else schedule();
  } catch { /* the logging path must never take the renderer down */ }
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, BATCH_MS);
}

/** Ship what is queued. Safe to call at any time, including from an unload handler. */
export function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length && !dropped) return;
  try {
    if (dropped) {
      // Say so IN the stream, at the point the loss happened. Together with the per-process `seq`,
      // this is what stops the log from quietly lying about its own completeness.
      queue.push({
        t: new Date().toISOString(), up: up(), lv: 'warn', cat: 'app',
        ev: 'log.dropped', proc: PROC, seq: seq++, ...(runId ? { run: runId } : {}),
        d: { count: dropped, where: 'renderer' },
      });
      dropped = 0;
    }
    const batch = queue;
    queue = [];
    if (HAS_WINDOW) window.artlux?.logRecords?.(batch);
  } catch { /* ignore */ }
}

// ── The call surface ──────────────────────────────────────────────────────────────────────────

export const log = {
  error: (cat: string, ev: string, d?: Record<string, unknown>, err?: unknown) => emit('error', cat, ev, d, err),
  warn:  (cat: string, ev: string, d?: Record<string, unknown>) => emit('warn', cat, ev, d),
  info:  (cat: string, ev: string, d?: Record<string, unknown>) => emit('info', cat, ev, d),
  debug: (cat: string, ev: string, d?: Record<string, unknown>) => emit('debug', cat, ev, d),
  trace: (cat: string, ev: string, d?: Record<string, unknown>) => emit('trace', cat, ev, d),
};

/**
 * Adopt every console line this window already writes (shared/consoleTap.ts).
 *
 * An explicit call from the entry, mirroring faultReporter's `installGlobalNet()`, rather than a
 * side-effect import: a bare `import './services/log'` is exactly the kind of thing a bundler is
 * entitled to drop, and it would fail SILENTLY — the app would run, the log would simply be emptier
 * than it should be, and nothing would say so.
 *
 * Call it FIRST, before prefs have been read: the interesting lines in a window's life are the early
 * ones — plugin activation, a mapper falling back, a project that will not load — and waiting for
 * configuration would lose exactly those to a race.
 */
export function installLogTap(): void {
  installConsoleTap(
    (lv, cat, _msg, extra) => emit(lv, cat, 'log.console', extra),
    (lv, cat) => isEnabled(lv, cat),
  );
}

// A window that is going away still owes its last batch. `pagehide` rather than `unload`: it fires in
// the cases `unload` misses (and is the one Chromium actually guarantees for a closing window).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => flush());
}
