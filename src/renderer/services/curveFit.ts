import type { Keyframe } from '../types';

// FITTING A RECORDED BUSK INTO EDITABLE KEYFRAMES.
//
// The reducer that came before this is Ramer–Douglas–Peucker, and its metric is the vertical
// distance to a STRAIGHT CHORD. That is the right tool for a polyline and the wrong one for a
// movement: a pan sine never straightens, so RDP keeps points in proportion to curvature ÷ ε and a
// three-minute capture lands as ~1200 dumb points. You cannot tune that. You can only re-record it.
//
// This fits CUBIC SEGMENTS instead — Schneider's method (Graphics Gems, 1990): parameterise the
// samples, least-squares the control points, reparameterise by Newton, and recursively split at the
// worst remaining error. The output is `Keyframe[]` with bezier handles, which is the SAME thing an
// automation lane stores, so a recording arrives as something an operator can grab and move.
//
// ── THE CONSTRAINT THAT SHAPES ALL OF THIS ───────────────────────────────────────────────────
// `Keyframe`'s bezier is a CSS-style TIMING FUNCTION, not a free 2-D cubic: p0=(0,0), p3=(1,1) in
// the segment's unit box, with `cx` clamped to [0,1] so x stays monotone and solvable (automation.ts
// inverts it by Newton at sample time). `cy` is deliberately unclamped — that is how you get
// overshoot. Two consequences the fitter must respect:
//
//   · the fit is constrained, not general — we solve for the four handle numbers of that form;
//   · ONE SEGMENT CANNOT HOLD AN INFLECTION, so a full sine period needs a key at each extreme.
//     That is what a human would draw anyway, and it is why the split step exists rather than being
//     an optimisation.

/** Bernstein basis for a unit-box cubic with p0=0, p3=1. */
const b1 = (s: number) => 3 * (1 - s) * (1 - s) * s;
const b2 = (s: number) => 3 * (1 - s) * s * s;
const b3 = (s: number) => s * s * s;
const bezAt = (s: number, c1: number, c2: number) => b1(s) * c1 + b2(s) * c2 + b3(s);
const bezDeriv = (s: number, c1: number, c2: number) => {
  const v = 1 - s;
  return 3 * v * v * c1 + 6 * v * s * (c2 - c1) + 3 * s * s * (1 - c2);
};

/**
 * Least-squares the two free control values for one axis, given the parameterisation `s`.
 *
 * Each sample gives `b1(s)·c1 + b2(s)·c2 = target - b3(s)`, so this is a 2×2 normal-equation solve.
 * A singular system means the samples carry no information about the handles (every s at an end),
 * and the caller falls back to a straight segment rather than inventing one.
 */
function solveHandles(s: number[], target: number[]): [number, number] | null {
  let a11 = 0, a12 = 0, a22 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < s.length; i++) {
    const p = b1(s[i]), q = b2(s[i]);
    const d = target[i] - b3(s[i]);
    a11 += p * p; a12 += p * q; a22 += q * q;
    r1 += p * d; r2 += q * d;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12) return null;
  return [(r1 * a22 - r2 * a12) / det, (a11 * r2 - a12 * r1) / det];
}

/** Newton step: pull each sample's parameter towards the s whose x(s) matches its own x. */
function reparameterise(s: number[], x: number[], cx1: number, cx2: number): number[] {
  return s.map((si, i) => {
    const d = bezDeriv(si, cx1, cx2);
    if (Math.abs(d) < 1e-9) return si;
    const next = si - (bezAt(si, cx1, cx2) - x[i]) / d;
    return next < 0 ? 0 : next > 1 ? 1 : next;
  });
}

interface Seg { cx1: number; cy1: number; cx2: number; cy2: number; err: number; worst: number }

/**
 * Invert x(s) = u then read y — EXACTLY what automation.ts's bezierEase does at sample time.
 *
 * The fitter must score itself the way the sampler will read it. Scoring at the parameters the fit
 * happened to land on instead is how the first version of this passed its own check while producing
 * a curve that was 238° out on the wire: least squares is free to choose an s for each sample, the
 * sampler is not.
 */
function easeAt(u: number, cx1: number, cy1: number, cx2: number, cy2: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let s = u;
  for (let i = 0; i < 8; i++) {
    const d = bezDeriv(s, cx1, cx2);
    if (Math.abs(d) < 1e-9) break;
    const next = s - (bezAt(s, cx1, cx2) - u) / d;
    if (next < 0 || next > 1) break;
    if (Math.abs(next - s) < 1e-9) { s = next; break; }
    s = next;
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 24 && (bezAt(s, cx1, cx2) - u) ** 2 > 1e-12; i++) {
    if (bezAt(s, cx1, cx2) < u) lo = s; else hi = s;
    s = (lo + hi) * 0.5;
  }
  return bezAt(s, cy1, cy2);
}

/**
 * Ramer–Douglas–Peucker, kept here as the fitter's SAFETY NET rather than as a rival.
 *
 * Its metric is vertical distance to a straight chord, so it is guaranteed within `epsilon` for any
 * input — which is exactly the property a bailout needs. Local rather than imported so this module
 * depends on nothing but `types`.
 */
function rdp(t: number[], v: number[], epsilon: number): Keyframe[] {
  const n = t.length;
  if (n < 3) return t.map((tt, i) => ({ t: tt, v: v[i], curve: 'linear' as const }));
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const t0 = t[first], v0 = v[first];
    const dt = t[last] - t0, dv = v[last] - v0;
    let worst = -1, worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const projected = dt === 0 ? v0 : v0 + (dv * (t[i] - t0)) / dt;
      const d = Math.abs(v[i] - projected);
      if (d > worst) { worst = d; worstIdx = i; }
    }
    if (worst > epsilon && worstIdx > 0) { keep[worstIdx] = 1; stack.push([first, worstIdx], [worstIdx, last]); }
  }
  const out: Keyframe[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ t: t[i], v: v[i], curve: 'linear' });
  return out;
}

/**
 * The turning point closest to the middle of the span, so a split halves the work.
 *
 * A "turning point" is any sample where the direction of travel reverses. Falls back to the exact
 * midpoint when the data is monotone (which only happens if the caller declined for another reason).
 */
function nearestExtremumToMiddle(v: number[]): number {
  const mid = v.length >> 1;
  let best = mid, bestDist = Infinity;
  for (let i = 1; i < v.length - 1; i++) {
    const a = v[i] - v[i - 1], b = v[i + 1] - v[i];
    if (a === 0 || b === 0 || (a > 0) === (b > 0)) continue;   // not a turning point
    const d = Math.abs(i - mid);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/** Fit ONE eased segment across samples [lo..hi]; report its worst deviation and where it is. */
function fitSegment(t: number[], v: number[], lo: number, hi: number): Seg | null {
  const t0 = t[lo], t1 = t[hi], v0 = v[lo], v1 = v[hi];
  const dt = t1 - t0, dv = v1 - v0;
  if (dt <= 0) return null;

  // ── THE INFLECTION GUARD ───────────────────────────────────────────────────────────────────
  // A timing function is monotone in x and has p0/p3 pinned, so ONE segment cannot hold an
  // extremum. A span that starts and ends near the same value but swings hugely in between (half a
  // sine, or a whole one) is exactly that shape, and least squares will happily "fit" it by driving
  // the cy handles to ~1/dv — a curve that passes through the samples at the parameters it chose and
  // is wild everywhere else. Decline, and let the caller split at the extremum instead.
  let min = Infinity, max = -Infinity;
  for (let i = lo; i <= hi; i++) { if (v[i] < min) min = v[i]; if (v[i] > max) max = v[i]; }
  const range = max - min;
  if (Math.abs(dv) < range * 0.25) return null;

  const x: number[] = [], y: number[] = [];
  for (let i = lo; i <= hi; i++) { x.push((t[i] - t0) / dt); y.push((v[i] - v0) / dv); }

  let s = x.slice();                       // x is near-identity, so it is a good first guess
  let cx1 = 1 / 3, cx2 = 2 / 3, cy1 = 1 / 3, cy2 = 2 / 3;
  for (let iter = 0; iter < 6; iter++) {
    const cx = solveHandles(s, x);
    const cy = solveHandles(s, y);
    if (!cx || !cy) return null;
    // cx MUST stay in [0,1] — outside it the timing function is not monotone in x and the sampler
    // cannot invert it. cy is left free: that is where overshoot lives.
    cx1 = Math.min(1, Math.max(0, cx[0]));
    cx2 = Math.min(1, Math.max(0, cx[1]));
    cy1 = cy[0]; cy2 = cy[1];
    s = reparameterise(s, x, cx1, cx2);
  }

  // Worst deviation, in the ROLE's own unit so `epsilon` means what it says, and measured through
  // the SAMPLER'S OWN inversion rather than at the parameters the fit chose.
  // A degenerate solve can hand back non-finite handles; those must never reach a Keyframe, where
  // they would become a NaN on the wire.
  if (![cx1, cy1, cx2, cy2].every(Number.isFinite)) return null;

  let err = 0, worst = lo;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs((easeAt(x[i], cx1, cy1, cx2, cy2) - y[i]) * dv);
    if (!Number.isFinite(d)) return null;
    if (d > err) { err = d; worst = lo + i; }
  }
  return { cx1, cy1, cx2, cy2, err, worst };
}

/**
 * Fit a sampled capture into keyframes whose worst deviation is within `epsilon`.
 *
 * `epsilon` is in the role's own unit — degrees for pan/tilt — exactly as reductionEpsilon() means
 * it, so the accuracy promise is unchanged and only the representation gets better.
 */
export function fitCurve(t: number[], v: number[], epsilon: number, depth = 0): Keyframe[] {
  const n = t.length;
  const linear = (i: number): Keyframe => ({ t: t[i], v: v[i], curve: 'linear' });
  if (n === 0) return [];
  if (n <= 2) return t.map((_, i) => linear(i));

  const fit = fitSegment(t, v, 0, n - 1);
  if (fit && fit.err <= epsilon) {
    return [
      { t: t[0], v: v[0], curve: 'bezier', cx1: fit.cx1, cy1: fit.cy1, cx2: fit.cx2, cy2: fit.cy2 },
      linear(n - 1),
    ];
  }

  // fitSegment declined: either genuinely flat, or it needs an inflection.
  let min = Infinity, max = -Infinity, minAt = 0, maxAt = 0;
  for (let i = 0; i < n; i++) {
    if (v[i] < min) { min = v[i]; minAt = i; }
    if (v[i] > max) { max = v[i]; maxAt = i; }
  }
  if (!fit && max - min <= epsilon) return [linear(0), linear(n - 1)];

  // SPLIT and recurse. When the fit was DECLINED the span holds an extremum, so split THERE — that
  // is the one point guaranteed to give both halves a shape this form can represent.
  //
  // ⚠ SPLIT AT THE MIDDLE-MOST EXTREMUM, not the first one. Peeling one quarter-period off the front
  // makes the recursion LINEAR in the number of extrema, so a 45-period capture blew the depth cap
  // and fell back to a 3-key linear span — 236° out on a 1° tolerance. Halving the span keeps it
  // logarithmic.
  // A worst-error sample sitting ON an endpoint would split off one sample and recurse on the rest —
  // no progress, and the depth cap arrives instead of a fit. Fall back to halving at a turning point.
  const at = fit && fit.worst > 0 && fit.worst < n - 1 ? fit.worst : nearestExtremumToMiddle(v);
  const k = Math.min(n - 2, Math.max(1, at));

  // DEPTH BAILOUT — and the fallback is what makes this whole file safe to ship.
  //
  // It used to emit three linear keys across whatever span was left, which for a 45-period capture
  // meant ONE straight line over fourteen periods: 235° out on a 1° tolerance, from a function whose
  // entire contract is a tolerance. Falling back to the RDP reduction instead means the fitter is
  // NEVER WORSE than the reducer it replaces — the worst case is simply that it did not improve.
  if (depth >= 24) return rdp(t, v, epsilon);

  const left = fitCurve(t.slice(0, k + 1), v.slice(0, k + 1), epsilon, depth + 1);
  const right = fitCurve(t.slice(k), v.slice(k), epsilon, depth + 1);
  // ⚠ THE JOIN SAMPLE BELONGS TO BOTH HALVES, AND THE RIGHT HALF'S COPY IS THE ONE TO KEEP.
  // `Keyframe.curve` shapes the segment STARTING at that key, so the join carries the OUTGOING
  // shape — which is the right half's. Keeping the left half's copy (whose role was to END its
  // segment, and which is therefore plain 'linear') silently straightens every joint: the first
  // version of this did exactly that and measured 27° out on a 1°-tolerance sine while reporting
  // a clean fit, because each half scored itself before being joined.
  return [...left.slice(0, -1), ...right];
}
