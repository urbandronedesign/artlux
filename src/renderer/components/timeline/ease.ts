// What a curve kind LOOKS like — its family (which glyph a key wears), its short name (what the label
// and the picker print) and its thumbnail path. ONE module, because three surfaces draw keys (the
// automation lane, the colour row, the lighting clip) and three editors pick an ease (the keyframe
// editor, the colour key panel, the lighting inspector): a family decided in two places would draw the
// same key two ways.
//
// THE THUMBNAIL IS SAMPLED, NOT DRAWN. It runs `segmentEase` — the function the engine plays — so a
// picture in the picker cannot disagree with what the curve does. The names come from EASE_FN's own
// keys for the same reason CurveOptions did: the picker cannot offer an ease the sampler does not have.
import type { CurveKind, EaseKind } from '../../types';
import { BEZ_DEFAULT, EASE_BEZIER, EASE_FN, segmentEase } from '../../services/automation';

export const EASE_NAMES = Object.keys(EASE_FN) as EaseKind[];
export const EASE_FAMILIES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'] as const;
export const EASE_DIRECTIONS = [
  { prefix: 'easeIn', short: 'in', hint: 'starts slowly' },
  { prefix: 'easeOut', short: 'out', hint: 'arrives slowly' },
  { prefix: 'easeInOut', short: 'in-out', hint: 'slow at both ends' },
] as const;

/**
 * Which GLYPH a key wears for the segment on one side of it — the After Effects reading:
 *   linear ◆ (diamond) · hold ■ (square) · ease ● (rounded) · overshoot ▷◁ (wedge)
 * Overshoot gets its own shape because back, elastic and bounce go PAST the next key's value before
 * settling — the one ease whose surprise is a wrong value on the rig, not just a timing feel.
 */
export type EaseFamily = 'linear' | 'hold' | 'ease' | 'overshoot';
export function easeFamily(curve: CurveKind | string | undefined): EaseFamily {
  if (!curve || curve === 'linear') return 'linear';
  if (curve === 'hold') return 'hold';
  if (curve === 'bezier') return 'ease';
  if (!curve.startsWith('ease') || !(curve in EASE_FN)) return 'linear';   // unknown ⇒ plays linear, so say linear
  return /(Back|Elastic|Bounce)$/.test(curve) ? 'overshoot' : 'ease';
}

/** `easeOutCubic` → `out cubic`. Unknown names print as stored, so a hand-edited value is visible. */
export function easeLabel(curve: CurveKind | string | undefined): string {
  if (!curve) return 'linear';
  for (const d of [...EASE_DIRECTIONS].reverse()) {          // easeInOut before easeIn — longest prefix first
    if (curve.startsWith(d.prefix) && curve.length > d.prefix.length) {
      return `${d.short} ${curve.slice(d.prefix.length).toLowerCase()}`;
    }
  }
  return curve;
}

/**
 * The fields to write when a key's curve becomes `next`. Going to `bezier` SEEDS THE HANDLES from the
 * ease it had (EASE_BEZIER), so a named ease is a starting point you can then drag — the rule the
 * keyframe editor has always followed, shared here so a multi-key ease follows it too.
 */
export function curvePatch(prev: string | undefined, next: CurveKind): { curve: CurveKind; cx1?: number; cy1?: number; cx2?: number; cy2?: number } {
  if (next !== 'bezier') return { curve: next };
  return { curve: next, ...(EASE_BEZIER[prev as EaseKind] ?? BEZ_DEFAULT) };
}

type Bez = { cx1?: number; cy1?: number; cx2?: number; cy2?: number };
// The thumbnail's vertical range. Elastic reaches about -0.37 and 1.37, so [0,1] would clip exactly
// the eases whose overshoot is the thing worth seeing.
const LO = -0.45, HI = 1.45;

/** An SVG path for `curve` across a w×h box, with `pad` px inside. `bez` shapes a bezier cell. */
export function easePath(curve: CurveKind | string, w: number, h: number, pad = 2, bez?: Bez): string {
  const n = 32;
  const iw = w - 2 * pad, ih = h - 2 * pad;
  const y = (v: number) => pad + (1 - (v - LO) / (HI - LO)) * ih;
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    // hold is the caller's business in the sampler (it returns a value, not a fraction); here it is
    // the step it plays as — flat until the next key.
    const e = curve === 'hold' ? (i === n ? 1 : 0) : segmentEase({ curve, ...bez }, u);
    pts.push(`${(pad + u * iw).toFixed(1)},${y(e).toFixed(1)}`);
  }
  return `M${pts.join(' L')}`;
}

/** The y of 0 and 1 in that same box — the faint guides a thumbnail draws so overshoot reads as such. */
export function easeGuides(h: number, pad = 2): { y0: number; y1: number } {
  const ih = h - 2 * pad;
  const y = (v: number) => pad + (1 - (v - LO) / (HI - LO)) * ih;
  return { y0: y(0), y1: y(1) };
}
