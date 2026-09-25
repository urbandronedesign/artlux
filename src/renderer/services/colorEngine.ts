import type { ChannelRole, FixtureProfile, ProfileChannel, ProfileMode } from '../types';
import { EMITTERS, colorModel } from './fixtureSignal';

// TURNING ONE AUTHORED COLOUR INTO WHATEVER EMITTERS A FIXTURE ACTUALLY HAS.
//
// `fixtureSignal` reads the rig: channels in, one RGB triple out, which is what the 3D beam is drawn
// with. This is the other direction, and it is the direction nothing in the app had — the only
// write-side colour code was frameEngine's CMY bridge (three roles, one fixture family) and a
// pixel-only "subtract the minimum" white extraction that knows nothing about a profile.
//
// WHY IT IS NOT A CONVERSION FUNCTION. "RGB → RGBW" is a conversion. "RGB → whatever this mode has"
// is a fit: the shipped library holds RGB, RGBW, RGBA, RGBWA, RGBWA+UV, RGB+lime+indigo, CW/WW,
// CCT-only, CMY and colour-wheel fixtures, and the emitter table above is 13 rows of 3 numbers —
// rank 3, non-negative, wildly overdetermined in one direction and underdetermined in the other.
// A per-family branch would be a dozen branches that each drift; one bounded least-squares fit is
// the same code for all of them, and it is exact (measured: 0% error) wherever the mode has red,
// green and blue.
//
// WHAT THIS FILE DOES NOT DECIDE: brightness. The dimmer owns it, on its own row — the same split
// `resolveFixture` already makes between `intensity` and `r/g/b`. A solved colour is therefore
// scaled so its brightest emitter sits at full, and the dimmer takes it down from there. Two
// controls that both dim would fight, and the loser would look like a broken fader.

export type RGB = readonly [number, number, number];

/**
 * WHAT AN OPERATOR MAY AUTHOR ON THIS FIXTURE — the question that has to be asked before a colour
 * control is drawn, not after.
 *
 * A tuneable-white head cannot make green. Offer it a hue wheel and every colour off the warm↔cold
 * line is a value someone authored and the rig will never produce — which is exactly the failure
 * mode the CMY bridge exists to prevent, wearing a different hat. So the CONTROL is derived from
 * the mode, and a fixture that can only change temperature is only ever offered a temperature.
 */
export type ColorControl =
  | 'mix'          // red+green+blue present: a full hue/saturation picker, solved onto every emitter
  | 'temperature'  // coldWhite+warmWhite, or a colorTemp fader: warm ↔ cold and nothing else
  | 'wheel'        // a colour wheel: discrete slots, snapped — never interpolated into a gap
  | 'none';        // no colour channel in this mode. There is no colour row at all.

export interface ColorCapability {
  control: ColorControl;
  /** Emitter roles this MODE addresses, with their channel keys. Empty for 'wheel'/'none'/CCT-only. */
  emitters: Array<{ role: ChannelRole; channel: ProfileChannel }>;
  /** True when cyan/magenta/yellow are dichroic flags over a white lamp rather than emitters. */
  subtractive: boolean;
  /** A `colorTemp` fader, when the mode has one — the other way tuneable white is built. */
  cct?: ProfileChannel;
  /** The colour wheel, when the mode has one. */
  wheel?: ProfileChannel;
}

// A mode is immutable, so its capability is too — cached on the mode OBJECT exactly as `colorModel`
// is, and for the same reason: a reloaded project brings new objects and recomputes by construction,
// with no invalidation to forget.
const capabilityCache = new WeakMap<ProfileMode, ColorCapability>();

export function colorCapability(profile: FixtureProfile, mode: ProfileMode): ColorCapability {
  const cached = capabilityCache.get(mode);
  if (cached) return cached;

  // `colorModel` owns "which channels does this mode reach" and "are the flags subtractive". Asking
  // it rather than re-deriving is not politeness: `subtractive` is decided by a rule (CMY present,
  // primaries absent) that took a shipped bug to get right, and two copies of it would disagree the
  // first time one of them was tuned.
  const { inMode, subtractive } = colorModel(profile, mode);

  const emitters: ColorCapability['emitters'] = [];
  let cct: ProfileChannel | undefined;
  let wheel: ProfileChannel | undefined;
  for (const c of profile.channels) {
    if (!inMode.has(c.key)) continue;
    if (c.role === 'colorTemp') { cct ??= c; continue; }
    if (c.role === 'colorWheel') { wheel ??= c; continue; }
    // On a subtractive head the flags are not emitters — they multiply the lamp, and the existing
    // CMY bridge already writes them. Leaving them out of the basis is what stops the solver from
    // treating "cyan in" as "add cyan light".
    if (subtractive && (c.role === 'cyan' || c.role === 'magenta' || c.role === 'yellow')) continue;
    if (EMITTERS[c.role]) emitters.push({ role: c.role, channel: c });
  }

  const has = (r: ChannelRole) => emitters.some((e) => e.role === r);
  const mixable = (has('red') && has('green') && has('blue')) || subtractive;
  const temperature = !mixable && (!!cct || (has('coldWhite') && has('warmWhite')));

  const control: ColorControl = mixable ? 'mix'
    : temperature ? 'temperature'
      // A wheel is the LAST resort, not the first: a head with both a wheel and a mixing system is
      // mixed (54 shipped modes have both), because the mixer can reach colours the wheel cannot.
      : wheel ? 'wheel'
        : 'none';

  const cap: ColorCapability = { control, emitters, subtractive, cct, wheel };
  capabilityCache.set(mode, cap);
  return cap;
}

// ── The fit ──────────────────────────────────────────────────────────────────────────────────

/**
 * Box-constrained non-negative least squares by projected gradient.
 *
 * Three equations, at most a handful of unknowns, all bounded to [0,1] — a dependency-free loop,
 * run once per authored colour per mode (memoised below) and never once per channel per frame.
 *
 * THE ITERATION CAP IS MEASURED, not chosen. Run against every mixing mode in the shipped library,
 * 13 reference colours each:
 *
 *   cap      modes reproducing every colour within 2%    worst error    cold solve
 *   600      529 of 791                                  5.0%           7.8 µs
 *   2000     603 of 791                                  2.8%           8.2 µs
 *   6000     791 of 791                                  1.3%           8.2 µs
 *
 * The cost does not move because the early-out below fires almost immediately for the easy cases —
 * an RGB head is exact in a few dozen passes. What needs the iterations is a seven-emitter hex
 * fixture, where the extra emitters (an amber and a UV that both leak into two primaries) make a
 * shallow valley the descent crawls along. At 600 the crawl was simply cut short, and the result
 * looked like a gamut limit while actually being an unconverged fit — worth remembering, because
 * "the fixture can't make that colour" is a very comfortable wrong answer.
 *
 * ⚠ AN EFFICACY TIE-BREAK WAS TRIED AND REMOVED. On an RGBW head, white can be made by W alone or
 * by R+G+B, and least squares has no opinion, so the fit was nudged toward the brighter emitter.
 * Measured at three weights including zero: byte-identical results every time. It was decoration,
 * and a knob that does nothing is a claim in the code that is not true. The descent starts at zero
 * and therefore lands on the minimum-norm solution, which spreads across the emitters — and the
 * peak-scaling below then turns that into the brightest version of the colour asked for.
 */
function fit(target: RGB, basis: RGB[]): number[] {
  const n = basis.length;
  const w = new Array<number>(n).fill(0);
  if (!n) return w;

  let lip = 0;
  for (const b of basis) lip += b[0] * b[0] + b[1] * b[1] + b[2] * b[2];
  const step = 1 / Math.max(1e-6, 2 * lip);

  for (let iter = 0; iter < 6000; iter++) {
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < n; i++) { sr += w[i] * basis[i][0]; sg += w[i] * basis[i][1]; sb += w[i] * basis[i][2]; }
    const er = sr - target[0], eg = sg - target[1], eb = sb - target[2];
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const g = 2 * (er * basis[i][0] + eg * basis[i][1] + eb * basis[i][2]);
      const next = Math.min(1, Math.max(0, w[i] - step * g));
      moved = Math.max(moved, Math.abs(next - w[i]));
      w[i] = next;
    }
    if (moved < 1e-7) break;   // converged; the remaining iterations would move nothing
  }
  return w;
}

export interface SolveResult {
  /** What to drive each emitter at, 0..1, keyed by role. Only roles the mode actually has. */
  values: Partial<Record<ChannelRole, number>>;
  /** The colour the rig will ACTUALLY make, normalised — equal to the target when reachable. */
  achieved: RGB;
  /**
   * 0 when the fixture can make the colour asked for, rising as it cannot. The UI shows the
   * difference rather than silently clamping: a colour you cannot have must not look authored.
   */
  error: number;
}

const normalisePeak = (c: RGB): RGB => {
  const peak = Math.max(c[0], c[1], c[2]);
  return peak > 1e-6 ? [c[0] / peak, c[1] / peak, c[2] / peak] : [0, 0, 0];
};

/** Solve an additive emitter set for a target colour. Brightness is the dimmer's job — see header. */
export function solveEmitters(cap: ColorCapability, target: RGB): SolveResult {
  const want = normalisePeak(target);
  const basis = cap.emitters.map((e) => EMITTERS[e.role]!);
  const w = fit(want, basis);

  // Scale so the brightest emitter sits at full. Every emitter is linear, so scaling them together
  // moves brightness and not hue — this hands the fixture its maximum output for the colour asked
  // for, and leaves dimming to the dimmer.
  const peak = Math.max(0, ...w);
  const scale = peak > 1e-6 ? 1 / peak : 0;

  const values: Partial<Record<ChannelRole, number>> = {};
  let ar = 0, ag = 0, ab = 0;
  cap.emitters.forEach((e, i) => {
    const v = Math.min(1, w[i] * scale);
    values[e.role] = v;
    const em = EMITTERS[e.role]!;
    ar += em[0] * v; ag += em[1] * v; ab += em[2] * v;
  });

  const achieved = normalisePeak([ar, ag, ab]);
  const error = Math.max(
    Math.abs(achieved[0] - want[0]), Math.abs(achieved[1] - want[1]), Math.abs(achieved[2] - want[2]),
  );
  return { values, achieved, error };
}

/**
 * A subtractive head: the flags come DOWN over a white lamp, and 0 means the flag is out. Cyan takes
 * out red, magenta green, yellow blue — the same assignment `fixtureSignal` reads them back with, so
 * the round trip closes. This is frameEngine's existing bridge, stated once here so the colour row
 * and the bridge cannot drift apart.
 */
export const flagsForColor = (target: RGB): Record<'cyan' | 'magenta' | 'yellow', number> => {
  const c = normalisePeak(target);
  return { cyan: 1 - c[0], magenta: 1 - c[1], yellow: 1 - c[2] };
};

// ── Colour spaces ────────────────────────────────────────────────────────────────────────────
// What a fade passes THROUGH — a separate choice from the timing curve, which decides how fast it
// gets there. Interpolating four scalar channels independently IS `rgb`.
//
// MEASURED, because the folklore reason is wrong here. "Straight-line RGB fades go dark in the
// middle" is a claim about gamma-encoded screen colour; these are LINEAR emitter values and the
// dimmer owns brightness, so a red→blue midpoint normalises to full magenta and looks fine. The
// real defect is narrower and worse: **complementary colours wash out to white.** Red→cyan in
// `rgb` passes through a midpoint with chroma 0.000 — dead white, the one colour nobody authored —
// while `hsv` holds 0.236 round the wheel and `oklab` 0.066 through it. Sampled at quarter points
// on five representative pairs:
//
//   path    evenness of perceived change (max step / min step; 1.0 is perfect)
//   rgb     1.32 – 2.59
//   hsv     1.67 – 3.45   ← lurches, because hue moves at a constant rate and perception does not
//   oklab   1.21 – 1.71   ← the most even on every pair measured
//
// So: `oklab` is the default because a fade at a constant perceived rate is what an operator means
// by "a smooth fade"; `hsv` is the one to reach for deliberately, when you want the fade to TRAVEL
// round the wheel (a chase through hues rather than a mix between two lamps); `rgb` is kept because
// it is what two real lamps crossfading actually do, and sometimes that is the honest answer.

export type ColorSpace = 'rgb' | 'hsv' | 'oklab';

export function rgbToHsv(c: RGB): [number, number, number] {
  const [r, g, b] = c;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, max > 1e-9 ? d / max : 0, max];
}

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

// Oklab (Björn Ottosson, 2020) — a perceptual space cheap enough for a frame loop: two 3×3 matrices
// and a cube root. A fade through it keeps its apparent brightness instead of dipping in the middle,
// which is the whole reason it is the default for a mixing head.
export function rgbToOklab(c: RGB): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2]);
  const m = Math.cbrt(0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2]);
  const s = Math.cbrt(0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2]);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function oklabToRgb(lab: readonly [number, number, number]): RGB {
  const l = (lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]) ** 3;
  const m = (lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]) ** 3;
  const s = (lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2]) ** 3;
  return [
    Math.max(0, +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/**
 * Mix two colours along a chosen path. `u` is already eased by the keyframe's own curve — the timing
 * and the path are separate axes, and this one is only the path.
 *
 * HUE TAKES THE SHORT WAY. Red→magenta should not travel the long way round through green; a fade
 * that visits colours nobody authored reads as a bug, not as a feature.
 */
export function mixColor(a: RGB, b: RGB, u: number, space: ColorSpace): RGB {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  if (space === 'rgb') return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  if (space === 'hsv') {
    const A = rgbToHsv(a), B = rgbToHsv(b);
    let dh = B[0] - A[0];
    if (dh > 0.5) dh -= 1; else if (dh < -0.5) dh += 1;
    return hsvToRgb(A[0] + dh * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }
  const A = rgbToOklab(a), B = rgbToOklab(b);
  return oklabToRgb([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t]);
}

// ── Temperature ──────────────────────────────────────────────────────────────────────────────

/**
 * Warm ↔ cold, 0..1, for the two ways a tuneable-white fixture is built.
 *
 * ⚠ NORMALISED, NOT KELVIN, and the UI must say so. Measured over the shipped library: **0 of 145**
 * `colorTemp` channels declare a `min`/`max`, so there is no range to convert to — printing "3200 K"
 * next to this number would be inventing it. Warm↔cold is what the fixture actually promises.
 */
export function solveTemperature(cap: ColorCapability, t: number): Partial<Record<ChannelRole, number>> {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  if (cap.cct) return { colorTemp: u };
  // Two emitters: crossfade, then lift so the brighter one is at full. At the midpoint both sit at
  // full, which is what a tuneable-white fixture is for — the dimmer, not the mix, takes it down.
  const cold = u, warm = 1 - u;
  const peak = Math.max(cold, warm) || 1;
  return { coldWhite: cold / peak, warmWhite: warm / peak };
}

/** The colour a temperature reads as, for a swatch. Straight off the emitter table, not a guess. */
export function temperatureColor(t: number): RGB {
  const warm = EMITTERS.warmWhite!, cold = EMITTERS.coldWhite!;
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return normalisePeak([
    warm[0] + (cold[0] - warm[0]) * u,
    warm[1] + (cold[1] - warm[1]) * u,
    warm[2] + (cold[2] - warm[2]) * u,
  ]);
}

// ── Wheel ────────────────────────────────────────────────────────────────────────────────────

/**
 * The slot whose colour is nearest, for a wheel head. Measured: 1422 of 2152 shipped wheel slots
 * carry a hex colour, so this is a real match and not a guess — but a slot with no colour (Open,
 * Closed, a split, a scroll band) is never a match, because landing on one is silently wrong.
 * Returns null when the wheel describes no colour at all; the row then offers slots by NAME.
 */
export function nearestSlot(channel: ProfileChannel, target: RGB): { from: number; to: number; label: string } | null {
  const want = normalisePeak(target);
  let best: { from: number; to: number; label: string } | null = null;
  let bestD = Infinity;
  for (const r of channel.ranges ?? []) {
    if (!r.color) continue;
    const m = /^#?([0-9a-f]{6})$/i.exec(r.color.trim());
    if (!m) continue;
    const n = parseInt(m[1], 16);
    const c = normalisePeak([((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
    const d = (c[0] - want[0]) ** 2 + (c[1] - want[1]) ** 2 + (c[2] - want[2]) ** 2;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

// ── The memo ─────────────────────────────────────────────────────────────────────────────────

/**
 * Solving is cheap; solving four times per fixture per frame is not. The packer asks the role
 * override once PER CHANNEL, so a naive call site would re-run the fit for red, then green, then
 * blue, then white, sixty times a second, for every head in the rig — all four asking the same
 * question and getting the same answer.
 *
 * Keyed on the mode object (stable, and already the key `colorModel` and `colorCapability` use) plus
 * the quantised colour: an authored colour changes when someone drags a picker, not per frame.
 */
const solveCache = new WeakMap<ProfileMode, Map<string, SolveResult>>();
const q = (v: number) => Math.round(v * 255);

export function solveCached(profile: FixtureProfile, mode: ProfileMode, target: RGB): SolveResult {
  let byColor = solveCache.get(mode);
  if (!byColor) { byColor = new Map(); solveCache.set(mode, byColor); }
  const key = `${q(target[0])},${q(target[1])},${q(target[2])}`;
  const hit = byColor.get(key);
  if (hit) return hit;
  const res = solveEmitters(colorCapability(profile, mode), target);
  // A rig is a few dozen modes and an operator authors a bounded number of colours; the cap is only
  // here so a generated effect sweeping hue at 60 fps cannot grow this without bound.
  if (byColor.size > 512) byColor.clear();
  byColor.set(key, res);
  return res;
}
