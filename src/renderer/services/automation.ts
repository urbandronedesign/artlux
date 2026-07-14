// The automation curve sampler — pure maths, no imports beyond types, no state of its own.
//
// This module is deliberately dependency-free because BOTH the engine (timeline.ts's frame loop) and the
// lane renderer (components/timeline/AutomationLane.tsx) evaluate curves through it. The curve you SEE
// drawn in the lane is literally the curve you HEAR — they cannot drift, because there is only one of them.
//
// Everything here runs inside the rAF frame loop, so it allocates nothing and its loops are bounded.
import type { Keyframe } from '../types';

/** Last-segment hint, carried across frames. Playback is monotone, so the steady-state search is 0 steps. */
export interface Cursor { i: number }

// Greatest index i where kfs[i].t <= t, or -1 if t precedes the first keyframe.
//
// `c.i` is last frame's answer. In steady playback the answer is the same index or the next one, so the
// walk is O(1). A scrub, a seek or a loop-wrap can land anywhere, so we detect that and fall back to a
// binary search rather than walking the array — a 200-keyframe lane scrubbed to the start would otherwise
// cost 200 steps in a frame.
function seekIdx(kfs: Keyframe[], t: number, c: Cursor): number {
  const n = kfs.length;
  let i = c.i;
  if (i < 0 || i >= n || kfs[i].t > t) i = -1; // cold, or the playhead moved BACKWARDS past our segment
  if (i === -1) {
    i = bsearch(kfs, t);
  } else {
    let steps = 0;
    while (i + 1 < n && kfs[i + 1].t <= t && steps++ < 8) i++;
    if (i + 1 < n && kfs[i + 1].t <= t) i = bsearch(kfs, t); // a big forward jump — stop walking
  }
  c.i = i;
  return i;
}

function bsearch(kfs: Keyframe[], t: number): number {
  if (kfs.length === 0 || t < kfs[0].t) return -1;
  let lo = 0, hi = kfs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (kfs[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// ── Bezier easing ───────────────────────────────────────────────────────────────────────────────
// A CSS-style timing function: p0=(0,0), p3=(1,1), two handles normalised into the segment's unit box.
// Normalised (rather than in/out tangents in absolute time/value space) so that DRAGGING A KEYFRAME NEVER
// INVALIDATES ITS NEIGHBOURS' CURVES — absolute tangents would need renormalising on every move, which is
// a whole class of bugs P4 does not need. cx is clamped to [0,1] so x stays monotone and solvable; cy is
// not, which is exactly how you get overshoot.
const bez = (u: number, p1: number, p2: number): number => {
  const v = 1 - u;
  return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u;
};
const bezD = (u: number, p1: number, p2: number): number => {
  const v = 1 - u;
  return 3 * v * v * p1 + 6 * v * u * (p2 - p1) + 3 * u * u * (1 - p2);
};

/** Solve x(s) = u for s (Newton, then bisection if the handle is degenerate), then return y(s). */
export function bezierEase(u: number, cx1: number, cy1: number, cx2: number, cy2: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let s = u;
  for (let n = 0; n < 4; n++) {
    const x = bez(s, cx1, cx2) - u;
    if (x > -1e-5 && x < 1e-5) return bez(s, cy1, cy2);
    const d = bezD(s, cx1, cx2);
    if (d < 1e-6) break; // flat x' — Newton can't help, bisect instead
    s -= x / d;
  }
  let lo = 0, hi = 1;
  s = u;
  for (let n = 0; n < 20; n++) {
    if (bez(s, cx1, cx2) < u) lo = s; else hi = s;
    s = (lo + hi) * 0.5;
  }
  return bez(s, cy1, cy2);
}

/** The shipped `smooth` ease — the default shape for a bezier segment. */
export const BEZ_DEFAULT = { cx1: 0.42, cy1: 0, cx2: 0.58, cy2: 1 } as const;

const lerp = (a: number, b: number, e: number) => a + (b - a) * e;
// Log-response targets (filter cutoff, delay time, attack/release) all have min > 0. Interpolating them
// in LOG space is what makes a straight line drawn on the lane's log axis actually be the sweep you hear:
// a linear ramp 20 Hz → 20 kHz spends half its time above 10 kHz and sounds like nothing happening, then
// everything at once. Keyframes stay in native units — a keyframe is still exactly what the slider wrote.
const lerpLog = (a: number, b: number, e: number) =>
  Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * e);

/**
 * Value of a lane at time `t`. Holds the first value before the first key and the last after the last,
 * so a lane is always defined everywhere on an unbounded timeline.
 */
export function sampleLane(kfs: Keyframe[], t: number, c: Cursor, log: boolean): number {
  const i = seekIdx(kfs, t, c);
  if (i < 0) return kfs[0].v;
  if (i >= kfs.length - 1) return kfs[kfs.length - 1].v;
  const a = kfs[i], b = kfs[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;    // coincident keys — the later one wins, i.e. a step
  if (a.curve === 'hold') return a.v;
  const u = (t - a.t) / span;   // in [0,1) by construction
  const e = a.curve === 'bezier'
    ? bezierEase(u, a.cx1 ?? BEZ_DEFAULT.cx1, a.cy1 ?? BEZ_DEFAULT.cy1, a.cx2 ?? BEZ_DEFAULT.cx2, a.cy2 ?? BEZ_DEFAULT.cy2)
    : u;                        // 'linear', and any unknown curve, degrade to linear
  return log ? lerpLog(a.v, b.v, e) : lerp(a.v, b.v, e);
}

// ── Value ⇄ lane-Y mapping (shared by the renderer and the keyframe editor) ─────────────────────
// A log target gets a log AXIS as well as log interpolation, so the drawn polyline is the sampled curve.
export const normValue = (v: number, min: number, max: number, log: boolean): number => {
  if (!log) return (v - min) / (max - min || 1);
  const lo = Math.log(Math.max(min, 1e-6)), hi = Math.log(Math.max(max, 1e-6));
  return (Math.log(Math.min(Math.max(v, min), max)) - lo) / (hi - lo || 1);
};
export const denormValue = (n: number, min: number, max: number, log: boolean): number => {
  const c = Math.min(1, Math.max(0, n));
  if (!log) return min + c * (max - min);
  const lo = Math.log(Math.max(min, 1e-6)), hi = Math.log(Math.max(max, 1e-6));
  return Math.exp(lo + c * (hi - lo));
};
