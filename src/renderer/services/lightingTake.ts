import type {
  ChannelRole, Keyframe, LightingClip, LightingEffect, LightingTake, LightingTakePart,
} from '../types';
import { sampleLane, type Cursor } from './automation';

// Sampling a light show: turning a take (or a generated effect) plus a clip's spread into "what is
// fixture N doing at time T".
//
// Pure, and deliberately so — this is the arithmetic that decides where forty heads point, and the
// only way to be sure of it is to check it against hand-computed values (see the throwaway script in
// docs/DEVELOPMENT.md → Testing). Nothing here touches state, the transport, or the DOM.

// ── SAMPLING A CURVE — one format, one sampler ───────────────────────────────────────────────
//
// This was a local binary search over `{t:[], v:[]}`. It is now `automation.sampleLane` over
// `Keyframe[]`: the SAME sampler an automation lane uses, so hold/linear/bezier segments come free
// and the search is a carried cursor rather than O(log n) per fixture per role per frame.
//
// `log` is ALWAYS false here. Log-space interpolation exists for audio targets whose axis is
// logarithmic (a filter cutoff sweeping 20 Hz → 20 kHz); a role is degrees or 0..1, both linear.
//
// Honest about the win: O(1) WITHIN a take cycle. `wrapIntoTake` jumps time backwards once per
// repeat, and the cursor re-seeks there — one binary search per fixture per wrap, not per frame.
export function sampleCurve(kfs: Keyframe[], time: number, cursor?: Cursor): number | undefined {
  if (!kfs.length) return undefined;
  return sampleLane(kfs, time, cursor ?? { i: -1 }, false);
}

/** A generated movement, evaluated analytically — no samples, no file. */
export function sampleEffect(effect: LightingEffect, time: number): number {
  const period = effect.periodSec > 0 ? effect.periodSec : 1;
  // `phase` here is the position within one cycle, 0..1.
  const p = ((time % period) + period) % period / period;
  let unit: number;
  switch (effect.form) {
    case 'sine': unit = Math.sin(p * Math.PI * 2); break;
    case 'triangle': unit = 1 - 4 * Math.abs(p - 0.5); break; // +1 at mid-cycle, -1 at both ends
    case 'ramp': unit = p * 2 - 1; break;
    case 'square': unit = p < 0.5 ? 1 : -1; break;
    // Deterministic pseudo-random per STEP, not per frame: a random effect that re-rolled every
    // frame would be a strobe, not a movement. One value per cycle, held.
    case 'random': unit = hash01(Math.floor(time / period)) * 2 - 1; break;
    default: unit = 0;
  }
  return effect.centre + unit * effect.amplitude;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * The time offset applied to fixture `index` of `total`, in seconds.
 *
 * This IS the effect engine. A console spreads a form across an ordered selection and calls the
 * result a chase, a wave or a fan depending on the spread; the form itself never changes.
 */
export function phaseOffset(clip: LightingClip, index: number, total: number): number {
  const step = clip.phase ?? 0;
  if (!step || total <= 1) return 0;

  switch (clip.phaseMode ?? 'spread') {
    case 'spread':
      return step * index;

    case 'wing': {
      // Mirror the spread outward from the centre, in N wings — the classic symmetric look, where
      // the outermost fixtures of each wing move together.
      const wings = Math.max(1, clip.wings ?? 2);
      const per = total / wings;
      const inWing = index % per;
      const fromCentre = Math.abs(inWing - (per - 1) / 2);
      return step * fromCentre;
    }

    case 'block': {
      // Fixtures move in N blocks: everything inside a block is in step with itself.
      const blocks = Math.max(1, clip.blocks ?? 2);
      const size = Math.max(1, Math.ceil(total / blocks));
      return step * Math.floor(index / size);
    }

    case 'random':
      // Stable per fixture index, so a "random" spread is the same every time the clip plays —
      // a show must be repeatable.
      return step * hash01(index * 7 + 13) * total;

    default:
      return step * index;
  }
}

/** Every role a take (or effect) can drive, honouring the clip's mask. */
export function rolesOf(clip: LightingClip, take: LightingTake | undefined): ChannelRole[] {
  const all = new Set<ChannelRole>();
  if (clip.effect) all.add(clip.effect.role);
  for (const part of take?.parts ?? []) {
    for (const role of Object.keys(part.channels) as ChannelRole[]) all.add(role);
  }
  const mask = clip.roleMask;
  return [...all].filter((r) => !mask || mask.includes(r));
}

export interface SampleContext {
  clip: LightingClip;
  take?: LightingTake;
  /** Seconds into the clip's own timeline (already trimmed by inPoint). */
  localTime: number;
  /** Position of this fixture within the target group. */
  index: number;
  total: number;
}

/**
 * What one fixture's role should be, at this moment, under this clip.
 *
 * Returns undefined when the take does not drive that role at all — which matters: a clip that only
 * carries movement must leave colour alone rather than forcing it to zero, so that two clips can
 * layer (movement from one, colour from another) the way a console layers effects.
 */
export function sampleRole(ctx: SampleContext, role: ChannelRole, cursor?: Cursor): number | undefined {
  const { clip, take, localTime, index, total } = ctx;
  const time = localTime - phaseOffset(clip, index, total);

  let value: number | undefined;
  if (clip.effect && clip.effect.role === role) {
    value = sampleEffect(clip.effect, time);
  } else if (take && take.parts.length) {
    // Part i drives fixture i, wrapping — so a one-part take fans across the whole group and an
    // eight-part recording of an eight-head chase stays intact.
    const part: LightingTakePart = take.parts[index % take.parts.length];
    const curve = part.channels[role];
    if (curve) value = sampleCurve(curve, wrapIntoTake(time, take.duration), cursor);
  }
  if (value === undefined) return undefined;

  // Amplitude and bias, about the value's own centre where one is known.
  const scale = clip.scale ?? 1;
  if (scale !== 1) {
    const centre = clip.effect && clip.effect.role === role ? clip.effect.centre : centreOf(take, role);
    value = centre + (value - centre) * scale;
  }
  if (clip.offset) value += clip.offset;

  // MIRROR flips the back half of the group about pan's centre. Only pan: mirroring tilt would aim
  // half the rig at the floor and the other half at the ceiling, which is never what is wanted.
  if (clip.mirror && role === 'pan' && index >= Math.ceil(total / 2)) {
    const centre = clip.effect?.role === 'pan' ? clip.effect.centre : centreOf(take, 'pan');
    value = centre - (value - centre);
  }

  return value;
}

/**
 * A take shorter than its clip repeats. That is what makes a two-second movement usable as a
 * thirty-second look, and it is also what a phase spread needs: a fixture delayed past the end of
 * the take must wrap back into it rather than freeze on the last sample.
 */
function wrapIntoTake(time: number, duration: number): number {
  if (!(duration > 0)) return 0;
  return ((time % duration) + duration) % duration;
}

/** The midpoint of a take's range for one role — the anchor `scale` and `mirror` work about. */
function centreOf(take: LightingTake | undefined, role: ChannelRole): number {
  let min = Infinity, max = -Infinity;
  for (const part of take?.parts ?? []) {
    const c = part.channels[role];
    if (!c) continue;
    for (const k of c) { if (k.v < min) min = k.v; if (k.v > max) max = k.v; }
  }
  return Number.isFinite(min) ? (min + max) / 2 : 0;
}

// ── Capture ──────────────────────────────────────────────────────────────────────────────────

/**
 * Ramer–Douglas–Peucker reduction, so a recorded curve keeps its SHAPE without keeping every frame.
 *
 * A three-minute capture at 60 fps is ~11,000 samples per role per fixture; almost all of them lie
 * on a straight line between their neighbours. `epsilon` is in the role's own unit, so half a degree
 * of pan is a sensible tolerance and 0.004 is about one step of an 8-bit channel.
 */
export function reduceCurve(curve: { t: number[]; v: number[] }, epsilon: number): Keyframe[] {
  const n = curve.t.length;
  const asKeys = (t: number[], v: number[]): Keyframe[] =>
    t.map((tt, i) => ({ t: tt, v: v[i], curve: 'linear' as const }));
  if (n < 3) return asKeys(curve.t, curve.v);
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;

  // Iterative rather than recursive: a long capture would otherwise blow the stack.
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const t0 = curve.t[first], v0 = curve.v[first];
    const dt = curve.t[last] - t0, dv = curve.v[last] - v0;
    let worst = -1, worstIdx = -1;
    for (let i = first + 1; i < last; i++) {
      // Vertical distance to the chord — the right measure here, because t and v are different
      // units and a perpendicular distance would mix seconds with degrees.
      const projected = dt === 0 ? v0 : v0 + (dv * (curve.t[i] - t0)) / dt;
      const d = Math.abs(curve.v[i] - projected);
      if (d > worst) { worst = d; worstIdx = i; }
    }
    if (worst > epsilon && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([first, worstIdx], [worstIdx, last]);
    }
  }

  // Emitted as LINEAR keyframes: RDP measures distance to a straight chord, so a straight chord is
  // exactly what it promises between the points it kept. (Fitting eased segments instead is E4 —
  // a different reducer, and a real accuracy claim that has to be measured, not assumed.)
  const out: Keyframe[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ t: curve.t[i], v: curve.v[i], curve: 'linear' });
  return out;
}

/**
 * Tolerance for reducing a role's curve, in that role's own unit — and therefore the knob that
 * decides how big a take is. Chosen by measurement, not by feel.
 *
 * A continuously-curving pan sine is the worst case (a reducer can do nothing with a shape that
 * never straightens). Measured at 60 fps with realistic frame jitter, for a 3-minute capture across
 * 4 roles × 8 parts:
 *
 *   tolerance   points kept        rough JSON size
 *     0.25°      2482 / 10779        ~1.2 MB
 *     0.5°       1612 / 10779        ~800 KB
 *     1.0°       1195 / 10779        ~600 KB   ← chosen
 *     2.0°        797 / 10779        ~400 KB
 *
 * 1° on a 540° head is 0.19% of travel — about 17 cm at a 10 m throw, well under both a real head's
 * repeatability and anything an audience could see. Below that the file grows fast for no visible
 * return; above it, a slow reveal starts to look stepped.
 *
 * 0.01 for the normalised roles is ~2.5 steps of an 8-bit channel: invisible in a fade, and it keeps
 * a recorded colour chase from costing as much as the movement.
 */
export function reductionEpsilon(role: ChannelRole): number {
  return role === 'pan' || role === 'tilt' ? 1.0 : 0.01;
}
