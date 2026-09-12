// THE ONE ANSWER TO "WHAT TIME IS THIS FRAME" — and the switch that lets the app render off the wall.
//
// WHY THIS EXISTS. Until now the render path read `performance.now()` in four unrelated places — the
// timeline's two anchors, the scene/cue fade stamp, the lighting-cue tick and the shader's iWallTime —
// so the app had four independent epochs that happened to agree because they all read the same monotonic
// source. That is fine while the only clock is the wall. It stops being fine the moment we want to
// render a frame that is NOT happening now: an offline bake steps time forward as fast (or as slowly) as
// the decoders and the GPU can serve it, and anything still reading the wall would run at wall speed
// while everything else ran at bake speed. A two-second scene fade would finish in two seconds of real
// time regardless of how many baked frames had gone past.
//
// So: one module, one epoch, and a mode flag. `now()` is the wall in live mode and a number we control
// in offline mode. Nothing else changes — every consumer keeps doing `(now - anchor) / 1000` exactly as
// before, which is why this is a net simplification rather than a new concept.
//
// NO IMPORTS, ON PURPOSE. This sits under engine/, which may not import React (verify:invariants), and
// it is read from the hottest loop in the app. It owns no state but the mode, the stepped time and a
// subscriber set.
//
// WHAT IT IS NOT. It is not a transport and it is not a show clock. `timeline.ts` still owns `playhead`
// and `showTime` and still derives both from their own anchors; this only decides what "now" means when
// those anchors are read. Putting the transport in here would be a second definition of the thing
// timeline.ts exists to be.

type Mode = 'live' | 'offline';

let mode: Mode = 'live';
/** The stepped time, in the same milliseconds-since-some-epoch units as performance.now(). */
let steppedMs = 0;

// Told when the mode flips, so an owner of a derived clock can re-anchor. Deliberately a plain set and
// not an event emitter: there are two subscribers and this must stay free of machinery.
const subs = new Set<(offline: boolean) => void>();

/**
 * The current frame's time, in milliseconds.
 *
 * Live: the wall. Offline: whatever stepTo() last set. Call it exactly where `performance.now()` used to
 * be called — the units and the monotonicity contract are identical, and in offline mode it is stable
 * for the whole of a frame, which is the other half of what makes a bake reproducible (two reads inside
 * one frame used to be able to differ by a millisecond).
 */
export function now(): number {
  return mode === 'live' ? performance.now() : steppedMs;
}

/** True while a non-realtime render owns the clock. Hot: called once per rAF by two loops. */
export function isOffline(): boolean {
  return mode === 'offline';
}

/**
 * Take the clock. `atMs` seeds the first frame's time — pass the wall clock to continue from where the
 * show is, which keeps derived anchors meaningful across the transition.
 *
 * Idempotent: beginning twice is a no-op rather than a reset, so a caller that is already rendering
 * cannot have its cursor yanked back by a second starter.
 */
export function beginOffline(atMs: number = performance.now()): void {
  if (mode === 'offline') return;
  steppedMs = atMs;
  mode = 'offline';
  notify();
}

/**
 * Move the clock to an absolute time. Absolute rather than a delta because the bake computes each
 * frame's time from its index (`start + i / fps`) — accumulating a per-frame delta would drift by
 * exactly the rounding error the fixed-rate stepping exists to avoid.
 *
 * Refuses to go backwards, and refuses at all in live mode: both would be a caller bug, and a clock that
 * silently obeyed either would produce a corrupt render rather than an error.
 */
export function stepTo(ms: number): void {
  if (mode !== 'offline') return;
  if (!Number.isFinite(ms) || ms < steppedMs) return;
  steppedMs = ms;
}

/**
 * Give the clock back to the wall.
 *
 * ⚠ THIS IS WHY subscribe() EXISTS. Every derived clock in the app is `(now - anchor) / 1000`, and while
 * we were offline the wall kept moving — by the whole duration of the bake, which may be minutes. Handing
 * `now()` back without telling anyone leaves those anchors describing an epoch that is long gone, and the
 * playhead leaps forward by the length of the render the instant the next frame is derived. The owner of
 * each anchor re-anchors on this signal; it cannot be done here, because this module deliberately does
 * not know what a playhead is.
 */
export function endOffline(): void {
  if (mode !== 'offline') return;
  mode = 'live';
  notify();
}

/** Told on every mode flip, with the new state. Returns an unsubscribe. */
export function subscribe(cb: (offline: boolean) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

function notify(): void {
  const offline = mode === 'offline';
  // Copied before iterating: a subscriber that unsubscribes itself in its own callback is legal, and
  // mutating a Set mid-iteration silently skips the next entry.
  for (const cb of [...subs]) {
    try { cb(offline); } catch (e) { console.error('[renderClock] subscriber threw', e); }
  }
}
