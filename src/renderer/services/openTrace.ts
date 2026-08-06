// PROJECT-OPEN TRACE — where did the cold open actually spend its time?
//
// The repo's profiling history is a list of confident zeroes (see scripts/trace-cdp.cjs's header), and
// the cold open is the one span none of the existing instruments cover: perfMonitor measures frames,
// trace-cdp measures a window you start by hand, and the boot gate only knows the tail (its own hold).
// The stretch from "main handed the renderer a project" to "the gate armed" — parse, apply, per-scene
// normalize, warm issuance, the swap — was invisible, which is exactly where a heavy project's cost
// lives. This module is a handful of named timestamps over that stretch, nothing more.
//
// It is deliberately dumb: no React, no subscriptions, no state beyond one array. Marks are cheap
// enough to leave in production (a push per open, not per frame), and the bench harness
// (scripts/bench-open.cjs) reads the result over CDP via window.__artluxOpenTrace — the same
// window-guarded pattern as hapDecode's __artluxHapStats.
//
// A new `begin()` starts a fresh trace: opens can repeat in one session (playlist, watchdog relaunch)
// and appending forever would make "the last open" unreadable.

export interface OpenMark {
  phase: string;   // e.g. 'apply-start', 'scenes-normalized', 'gate-armed'
  at: number;      // ms since begin() (performance.now-based)
  delta: number;   // ms since the previous mark — the column you actually read
}

let t0 = 0;
let marks: OpenMark[] = [];

// Start a fresh trace. Called at the earliest renderer-side moment of an open (project data received).
export function begin(): void {
  t0 = performance.now();
  marks = [{ phase: 'begin', at: 0, delta: 0 }];
}

// Record a named point. Safe to call with no begin() (e.g. the very first HMR load) — it self-starts,
// so a missed begin degrades to slightly-wrong absolute times rather than a throw inside App.
export function mark(phase: string): void {
  if (!t0) begin();
  const at = performance.now() - t0;
  const prev = marks.length ? marks[marks.length - 1].at : 0;
  marks.push({ phase, at: Math.round(at * 10) / 10, delta: Math.round((at - prev) * 10) / 10 });
}

export function snapshot(): OpenMark[] {
  return marks.slice();
}

// One table per open, logged by bootGate when it releases — the moment the whole span is known.
export function logTable(): void {
  if (marks.length <= 1) return;
  // console.table would be nicer to read but is invisible to a CDP console-drain; one line per mark
  // keeps the bench harness (and a venue log) able to parse it.
  console.log('[open-trace] ' + marks.slice(1).map(m => `${m.phase}=${m.at}ms(+${m.delta})`).join(' '));
}

// The bench harness reads this over CDP. Guarded like hapDecode's __artluxHapStats: this module is
// also imported by tsc-checked test scripts where `window` does not exist.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__artluxOpenTrace'] = snapshot;
}
