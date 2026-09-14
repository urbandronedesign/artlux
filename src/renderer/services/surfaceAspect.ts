// A surface's SHAPE — the aspect ratio an operator locks it to, and the arithmetic that keeps it.
//
// ── WHY A RATIO IS JUST width / height HERE ─────────────────────────────────────────────────────────
// The stage is a SQUARE unit space (Stage.tsx `contentAspect = 1`; the 512² composite; the preview
// canvas sized s.width*512 × s.height*512), so a surface's normalised width / height is the shape you
// see, the shape its content is rendered at (shaderDrawable / textRaster size by it) and the shape a
// projector shows once warped. There is no stage size to multiply through. A 16:9 surface is simply
// one whose width is 16/9 of its height.
//
// ── WHAT A LOCK HAS TO SURVIVE ──────────────────────────────────────────────────────────────────────
// Three things change a surface's rect, and each one must keep a chosen shape:
//   • the Transform Width / Height fields — sizeKeeping() below moves the other side with them;
//   • the stage's corner handle — already keeps the ratio it started from (Stage.tsx), lock or not;
//   • the automatic fit to content (frameEngine.tick) — which would otherwise re-derive the height
//     from the media the moment an image or video loaded, silently undoing the choice. It skips any
//     surface with an aspect; see isLocked().
// Scene fades and automation lanes move width and height as independent numbers and are NOT held to
// the lock: they are the operator's own authored values, and a fade that fought them would be worse.
//
// Pure — no React, no state — so the inspector, the engine and a test can all call the same maths.

import type { Surface, SurfaceAspect } from '../types';

export interface AspectPreset {
  id: SurfaceAspect;
  label: string;
  /** Landscape width ÷ height. */
  ratio: number;
  /** What it is usually for — shown in the picker so the choice is not a guess. */
  hint: string;
}

// Most common first. The labels are the ratios people say out loud; the hint says where they meet it.
export const ASPECT_PRESETS: AspectPreset[] = [
  { id: '16:9', label: '16:9', ratio: 16 / 9, hint: 'HD / 4K projectors and screens' },
  { id: '16:10', label: '16:10', ratio: 16 / 10, hint: 'WUXGA projectors, laptops' },
  { id: '4:3', label: '4:3', ratio: 4 / 3, hint: 'older projectors, XGA' },
  { id: '21:9', label: '21:9', ratio: 21 / 9, hint: 'ultrawide screens, cinema' },
  { id: '1:1', label: '1:1', ratio: 1, hint: 'square' },
];

const byId = new Map(ASPECT_PRESETS.map((p) => [p.id, p]));

/** Is this surface's shape pinned? (An unknown id from a newer build reads as free, not as a crash.) */
export function isLocked(s: Pick<Surface, 'aspect'>): boolean {
  return !!s.aspect && byId.has(s.aspect);
}

/** The width ÷ height this surface is locked to, portrait applied — or null when free. */
export function lockedRatio(s: Pick<Surface, 'aspect' | 'portrait'>): number | null {
  const p = s.aspect ? byId.get(s.aspect) : undefined;
  if (!p) return null;
  return s.portrait && p.ratio !== 1 ? 1 / p.ratio : p.ratio;
}

/** Can this shape be turned on its end? 1:1 and free cannot. */
export function hasOrientation(s: Pick<Surface, 'aspect'>): boolean {
  const p = s.aspect ? byId.get(s.aspect) : undefined;
  return !!p && p.ratio !== 1;
}

/**
 * The patch that gives a surface a new shape.
 *
 * RESHAPED ABOUT ITS CENTRE, KEEPING ITS LONGER SIDE. Keeping the top-left corner (what the content
 * fit does) makes a surface appear to slide as it changes shape; keeping the centre leaves it where the
 * operator put it. Keeping the longer side means switching 16:9 ↔ 16:10 ↔ 4:3 changes the short side
 * only, and flipping to portrait stands the same surface on its end rather than shrinking it.
 * Choosing Free clears the lock and leaves the rect exactly as it is.
 */
export function reshape(s: Surface, aspect: SurfaceAspect | undefined, portrait: boolean): Partial<Surface> {
  const next = { aspect, portrait: aspect && aspect !== '1:1' ? portrait : undefined };
  const ratio = lockedRatio(next);
  if (ratio === null) return { aspect: undefined, portrait: undefined };
  const long = Math.max(s.width, s.height);
  const width = Math.max(0.01, ratio >= 1 ? long : long * ratio);
  const height = Math.max(0.01, ratio >= 1 ? long / ratio : long);
  const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
  return { ...next, width, height, x: cx - width / 2, y: cy - height / 2 };
}

/**
 * A Width or Height edit that keeps a locked shape: the other side follows. The top-left corner stays,
 * like a free edit of that one field would — the operator is typing a size, not moving the surface.
 */
export function sizeKeeping(s: Surface, side: 'width' | 'height', value: number): Partial<Surface> {
  const v = Math.max(0.01, value);
  const ratio = lockedRatio(s);
  if (ratio === null) return { [side]: v };
  return side === 'width'
    ? { width: v, height: Math.max(0.01, v / ratio) }
    : { height: v, width: Math.max(0.01, v * ratio) };
}
