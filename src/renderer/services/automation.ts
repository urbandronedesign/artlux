// The automation curve sampler — pure maths, no imports beyond types, no state of its own.
//
// This module is deliberately dependency-free because BOTH the engine (timeline.ts's frame loop) and the
// lane renderer (components/timeline/AutomationLane.tsx) evaluate curves through it. The curve you SEE
// drawn in the lane is literally the curve you HEAR — they cannot drift, because there is only one of them.
//
// Everything here runs inside the rAF frame loop, so it allocates nothing and its loops are bounded.
import type { EaseKind, Keyframe } from '../types';

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

// ── Named eases ─────────────────────────────────────────────────────────────────────────────────
// The classic easing set (easings.net), as closed-form functions of u in [0,1]. A key names one in
// `curve` and carries nothing else, so these work wherever a curve kind is stored — automation keys,
// colour keys, lighting keys. Back and elastic leave [0,1] on purpose (overshoot), exactly as a bezier
// with cy outside the box does.
const B1 = 1.70158, B2 = B1 * 1.525, B3 = B1 + 1;
const E4 = (2 * Math.PI) / 3, E5 = (2 * Math.PI) / 4.5;
const bounceOut = (x: number): number => {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) { x -= 1.5 / d; return n * x * x + 0.75; }
  if (x < 2.5 / d) { x -= 2.25 / d; return n * x * x + 0.9375; }
  x -= 2.625 / d; return n * x * x + 0.984375;
};
const pin = (x: number, f: (x: number) => number): number => (x <= 0 ? 0 : x >= 1 ? 1 : f(x));
export const EASE_FN: Record<EaseKind, (x: number) => number> = {
  easeInSine: (x) => 1 - Math.cos((x * Math.PI) / 2),
  easeOutSine: (x) => Math.sin((x * Math.PI) / 2),
  easeInOutSine: (x) => -(Math.cos(Math.PI * x) - 1) / 2,
  easeInQuad: (x) => x * x,
  easeOutQuad: (x) => 1 - (1 - x) * (1 - x),
  easeInOutQuad: (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2),
  easeInCubic: (x) => x * x * x,
  easeOutCubic: (x) => 1 - Math.pow(1 - x, 3),
  easeInOutCubic: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  easeInQuart: (x) => x * x * x * x,
  easeOutQuart: (x) => 1 - Math.pow(1 - x, 4),
  easeInOutQuart: (x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2),
  easeInQuint: (x) => x * x * x * x * x,
  easeOutQuint: (x) => 1 - Math.pow(1 - x, 5),
  easeInOutQuint: (x) => (x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2),
  easeInExpo: (x) => pin(x, (v) => Math.pow(2, 10 * v - 10)),
  easeOutExpo: (x) => pin(x, (v) => 1 - Math.pow(2, -10 * v)),
  easeInOutExpo: (x) => pin(x, (v) => (v < 0.5 ? Math.pow(2, 20 * v - 10) / 2 : (2 - Math.pow(2, -20 * v + 10)) / 2)),
  easeInCirc: (x) => 1 - Math.sqrt(1 - Math.pow(x, 2)),
  easeOutCirc: (x) => Math.sqrt(1 - Math.pow(x - 1, 2)),
  easeInOutCirc: (x) => (x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2),
  easeInBack: (x) => B3 * x * x * x - B1 * x * x,
  easeOutBack: (x) => 1 + B3 * Math.pow(x - 1, 3) + B1 * Math.pow(x - 1, 2),
  easeInOutBack: (x) => (x < 0.5
    ? (Math.pow(2 * x, 2) * ((B2 + 1) * 2 * x - B2)) / 2
    : (Math.pow(2 * x - 2, 2) * ((B2 + 1) * (x * 2 - 2) + B2) + 2) / 2),
  easeInElastic: (x) => pin(x, (v) => -Math.pow(2, 10 * v - 10) * Math.sin((v * 10 - 10.75) * E4)),
  easeOutElastic: (x) => pin(x, (v) => Math.pow(2, -10 * v) * Math.sin((v * 10 - 0.75) * E4) + 1),
  easeInOutElastic: (x) => pin(x, (v) => (v < 0.5
    ? -(Math.pow(2, 20 * v - 10) * Math.sin((20 * v - 11.125) * E5)) / 2
    : (Math.pow(2, -20 * v + 10) * Math.sin((20 * v - 11.125) * E5)) / 2 + 1)),
  easeInBounce: (x) => 1 - bounceOut(1 - x),
  easeOutBounce: bounceOut,
  easeInOutBounce: (x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2),
};

type Bez = { cx1: number; cy1: number; cx2: number; cy2: number };
const bz = (cx1: number, cy1: number, cx2: number, cy2: number): Bez => ({ cx1, cy1, cx2, cy2 });
/**
 * The cubic-bezier that draws each named ease, where one exists (elastic and bounce are not cubics).
 * NOT used to sample — `EASE_FN` is exact. It SEEDS THE HANDLES when a key goes from a named ease to
 * `bezier`, so "start from easeOutBack and adjust it" is one pick in the editor.
 */
export const EASE_BEZIER: Partial<Record<EaseKind, Bez>> = {
  easeInSine: bz(0.12, 0, 0.39, 0), easeOutSine: bz(0.61, 1, 0.88, 1), easeInOutSine: bz(0.37, 0, 0.63, 1),
  easeInQuad: bz(0.11, 0, 0.5, 0), easeOutQuad: bz(0.5, 1, 0.89, 1), easeInOutQuad: bz(0.45, 0, 0.55, 1),
  easeInCubic: bz(0.32, 0, 0.67, 0), easeOutCubic: bz(0.33, 1, 0.68, 1), easeInOutCubic: bz(0.65, 0, 0.35, 1),
  easeInQuart: bz(0.5, 0, 0.75, 0), easeOutQuart: bz(0.25, 1, 0.5, 1), easeInOutQuart: bz(0.76, 0, 0.24, 1),
  easeInQuint: bz(0.64, 0, 0.78, 0), easeOutQuint: bz(0.22, 1, 0.36, 1), easeInOutQuint: bz(0.83, 0, 0.17, 1),
  easeInExpo: bz(0.7, 0, 0.84, 0), easeOutExpo: bz(0.16, 1, 0.3, 1), easeInOutExpo: bz(0.87, 0, 0.13, 1),
  easeInCirc: bz(0.55, 0, 1, 0.45), easeOutCirc: bz(0, 0.55, 0.45, 1), easeInOutCirc: bz(0.85, 0, 0.15, 1),
  easeInBack: bz(0.36, 0, 0.66, -0.56), easeOutBack: bz(0.34, 1.56, 0.64, 1), easeInOutBack: bz(0.68, -0.6, 0.32, 1.6),
};

/**
 * The eased fraction of a segment whose OUTGOING key is `a`, at linear fraction `u`. The one place a
 * curve kind becomes a number: the automation sampler below and the colour sampler (colorPlayback.ts)
 * both call it, so a kind added here exists everywhere at once. `hold` is the caller's business (it
 * returns a value, not a fraction). 'linear', and any curve this build does not know, are linear.
 */
export function segmentEase(a: { curve?: string; cx1?: number; cy1?: number; cx2?: number; cy2?: number }, u: number): number {
  const c = a.curve;
  if (!c || c === 'linear') return u;
  if (c === 'bezier') {
    return bezierEase(u, a.cx1 ?? BEZ_DEFAULT.cx1, a.cy1 ?? BEZ_DEFAULT.cy1, a.cx2 ?? BEZ_DEFAULT.cx2, a.cy2 ?? BEZ_DEFAULT.cy2);
  }
  // `startsWith` before the lookup: the table is a plain object, and a hand-edited `curve: "toString"`
  // must not find a function on its prototype.
  const f = c.startsWith('ease') ? EASE_FN[c as EaseKind] : undefined;
  return f ? f(u) : u;
}

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
  const e = segmentEase(a, u); // 'linear', and any unknown curve, degrade to linear
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
