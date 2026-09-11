// Per-consumer state for TEXT content: the typed copy, shaped and drawn, and the last frame handed out.
//
// A "consumer" is a surface id, or `layer:<id>` for a timeline clip — the same keying every other
// content source uses.
//
// ── WHY CANVAS 2D DRAWS THE GLYPHS ─────────────────────────────────────────────────────────────────
// `fillText` is not a fallback here, it is the feature. It runs Chromium's own HarfBuzz, so kerning,
// ligatures, combining accents, œ, CJK and right-to-left all come out correct for free. Shaping text
// is months of work and the part of "text" that is actually hard; a GPU glyph path would hand us
// back the easy half and make us own the difficult one. What the GPU is for here is MOVING the
// result, which is stage 2 (textGL) — and which a still surface never pays for at all.
//
// ── WHY THE CACHE IS NOT AN OPTIMISATION ───────────────────────────────────────────────────────────
// `transferToImageBitmap` CLEARS the canvas. The frame engine asks for a surface's drawable and then
// the 3D viewport asks again in its own loop, so without a repeat-call guard the second caller gets a
// blank frame and everything past the first pays a full re-render. Both surfaceFx.ts and
// shaderDrawable.ts hit exactly this and say so. Same signature in, same bitmap out.

import type { SurfaceContent } from '@/types';
import { getSurface } from '@/services/surfaceMedia'; // host service (transitional runtime seam, as in shaderDrawable)
import { familyFor, revision as fontRevision } from './fontAssets';

interface Entry {
  bitmap: ImageBitmap | null;
  /** Everything that determines the PIXELS. Equal signature ⇒ the last bitmap is still correct. */
  sig: string;
  /** Bumped only when a new bitmap is stored, so it is stable exactly when the picture is. */
  gen: number;
}

const entries = new Map<string, Entry>();

/** Detail rungs — a PIXEL BUDGET each, not a literal size (see sizeFor). Mirrors the shader plugin. */
export const RENDER_HEIGHTS = [360, 720, 1080, 1440, 2160] as const;
export const DEFAULT_RES = 720;

// Defaults live here, once, so the editor, the raster and the docs cannot drift apart.
export const DEFAULTS = {
  body: 'Text',
  font: 'IBM Plex Sans',
  weight: 400,
  size: 0.2,          // fraction of surface height
  lineHeight: 1.2,
  tracking: 0,
  align: 'center' as const,
  color: '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 0,
};

/**
 * WHICH WINDOW THIS IS, because the answer changes what the type is drawn at.
 *
 * The main window feeds the mapper, whose atlas rect is scaled to fixture density and throws away
 * anything finer. A projector window feeds a real projector, where glyph edges are exactly what an
 * audience sees a resolution limit in — so it rasterises at the OUTPUT's own pixel count. Same string,
 * two very different rasters: that is the point of shipping the TEXT between windows, not the pixels.
 */
let windowKind: 'main' | 'projector' = 'main';
export function setWindowKind(kind: 'main' | 'projector'): void { windowKind = kind; }

const QUANT = 16;
const MIN_DIM = 64;
const MAX_DIM = 3840;

/**
 * THE BUFFER TAKES THE SURFACE'S SHAPE.
 *
 * The compositor draws a drawable with `ctx.drawImage(d, x, y, w, h)` — it STRETCHES the picture into
 * the surface rect. So the buffer's aspect must equal the surface's or the type is distorted by
 * however much the two disagree, and stretched type is obvious in a way stretched noise is not.
 * `textRes` therefore names a pixel BUDGET spent in this surface's proportions. Quantised to 16 px so
 * that dragging a surface crosses a size boundary occasionally rather than reallocating every frame.
 */
export function sizeFor(res: number, aspect: number): { w: number; h: number } {
  const budget = windowKind === 'projector' && typeof window !== 'undefined'
    ? Math.max(1, window.innerWidth) * Math.max(1, window.innerHeight)
    : res * ((res * 16) / 9);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const q = (v: number) => Math.min(MAX_DIM, Math.max(MIN_DIM, Math.round(v / QUANT) * QUANT));
  return { w: q(Math.sqrt(budget * a)), h: q(Math.sqrt(budget / a)) };
}

/** The surface's aspect in mapping space, or 16:9 when there is no surface to ask. */
export function aspectFor(key: string): number {
  const s = getSurface(key);
  return s && s.width > 0 && s.height > 0 ? s.width / s.height : 16 / 9;
}

/** The CSS font shorthand this content asks for. A quoted family survives spaces and punctuation. */
function fontOf(c: SurfaceContent, px: number): string {
  // An IMPORTED typeface wins over a named one: it is the face the show CARRIES, so it is the face the
  // venue machine will actually have. familyFor registers and loads it on first ask and hands back a
  // family of our own naming; until the bytes land Canvas draws the fallback, and fontRevision() in the
  // signature is what redraws once they have.
  const asset = c.textFontAsset ? familyFor(c.textFontAsset) : null;
  const fam = asset ?? ((c.textFont ?? DEFAULTS.font).trim() || DEFAULTS.font);
  const style = c.textItalic ? 'italic ' : '';
  const weight = c.textWeight ?? DEFAULTS.weight;
  // The generic fallback matters: an unknown family silently falls back to something, and sans-serif
  // is a far better "something" than whatever the platform picks for an unrecognised name.
  return `${style}${weight} ${px}px "${fam.replace(/"/g, '')}", sans-serif`;
}

/** Only the fields that change the PIXELS. Motion (x/y/scale/rotate) is stage 2 and deliberately absent. */
function signatureOf(c: SurfaceContent, w: number, h: number): string {
  return [
    c.textBody ?? DEFAULTS.body, c.textFont ?? '', c.textFontAsset ?? '',
    c.textWeight ?? '', c.textItalic ? 'i' : '',
    c.textSize ?? '', c.textLineHeight ?? '', c.textTracking ?? '', c.textAlign ?? '',
    c.textColor ?? '', c.textStrokeColor ?? '', c.textStrokeWidth ?? '', `${w}x${h}`,
    // Not a property of the content — a property of what THIS WINDOW has finished loading. Without it,
    // an imported face arriving after the first raster would never be drawn: nothing else about the
    // surface changed, so the cache would keep handing back the substitute indefinitely.
    fontRevision(),
  ].join('|');
}

// One scratch canvas per window, reused. Allocating a canvas per draw is what made the shader plugin's
// early spike thrash the GPU process; and because `transferToImageBitmap` hands the buffer away, one
// canvas can serve every consumer in turn.
let scratch: OffscreenCanvas | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

function canvasFor(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!scratch || scratch.width !== w || scratch.height !== h) {
    scratch = new OffscreenCanvas(w, h);
    scratchCtx = scratch.getContext('2d');
  }
  return scratchCtx;
}

/** Draw the copy into `g`, which is already sized w×h and cleared. */
function paint(g: OffscreenCanvasRenderingContext2D, c: SurfaceContent, w: number, h: number): void {
  const body = c.textBody ?? DEFAULTS.body;
  const px = Math.max(1, (c.textSize ?? DEFAULTS.size) * h);
  const lineH = (c.textLineHeight ?? DEFAULTS.lineHeight) * px;
  const align = c.textAlign ?? DEFAULTS.align;

  g.font = fontOf(c, px);
  // Chromium supports canvas letterSpacing; older engines ignore the assignment rather than throwing,
  // which degrades to "no tracking" instead of no text.
  const track = (c.textTracking ?? DEFAULTS.tracking) * px;
  try { (g as unknown as { letterSpacing: string }).letterSpacing = `${track}px`; } catch { /* ignore */ }
  g.textBaseline = 'alphabetic';
  g.textAlign = align;

  const lines = body.split('\n');
  // The block is centred on the surface, then nudged by the normalized motion offsets. Centring is
  // the useful default for type on a mapped surface — a title on a wall is centred far more often
  // than it is flush to a corner, and flush is one slider away.
  const x = (align === 'left' ? 0 : align === 'right' ? w : w / 2);
  const blockH = lines.length * lineH;
  // Baseline of the first line: centre the block, then drop to the first baseline. 0.72 of the em is
  // a serviceable cap-height approximation across families without measuring every one.
  let y = (h - blockH) / 2 + px * 0.72;

  const stroke = (c.textStrokeWidth ?? DEFAULTS.strokeWidth) * px;
  g.lineJoin = 'round';   // a mitre on a tight corner spikes far past the glyph at heavy weights
  g.miterLimit = 2;

  for (const line of lines) {
    if (stroke > 0) {
      g.lineWidth = stroke * 2;                      // half of it is hidden under the fill
      g.strokeStyle = c.textStrokeColor ?? DEFAULTS.strokeColor;
      g.strokeText(line, x, y);
    }
    g.fillStyle = c.textColor ?? DEFAULTS.color;
    g.fillText(line, x, y);
    y += lineH;
  }
}

/**
 * The cached raster for this consumer. Null only when there is no OffscreenCanvas at all.
 *
 * Note what is NOT an argument: time. Stage 1 does not animate — the same copy in the same box is the
 * same pixels forever, which is exactly what makes a still text surface free.
 */
export function getFor(key: string, content: SurfaceContent): ImageBitmap | null {
  const { w, h } = sizeFor(content.textRes ?? DEFAULT_RES, aspectFor(key));
  const sig = signatureOf(content, w, h);
  const prev = entries.get(key);
  if (prev && prev.sig === sig && prev.bitmap) return prev.bitmap;

  const g = canvasFor(w, h);
  if (!g) return prev?.bitmap ?? null;
  g.clearRect(0, 0, w, h);
  paint(g, content, w, h);
  const bmp = (scratch as OffscreenCanvas).transferToImageBitmap();

  const entry: Entry = prev ?? { bitmap: null, sig: '', gen: 0 };
  entry.bitmap?.close();   // the frame handed out last time; skipping this leaks one bitmap per change
  entry.bitmap = bmp;
  entry.gen++;
  entry.sig = sig;
  entries.set(key, entry);
  return bmp;
}

/**
 * A value that changes only when this consumer's pixels changed — the whole reason text is cheap.
 *
 * With this, the 3D texture upload, the projector pump's per-window `createImageBitmap` and each
 * projector window's repaint all skip a still surface entirely. Undefined for a key never drawn,
 * which means "assume it changed" and is the safe answer.
 */
export function generationOf(key: string): number | undefined {
  return entries.get(key)?.gen;
}

export function release(key: string): void {
  entries.get(key)?.bitmap?.close();
  entries.delete(key);
}
