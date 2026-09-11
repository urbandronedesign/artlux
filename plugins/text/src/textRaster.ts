// Per-consumer state for TEXT content: the typed copy, shaped and drawn, and the last frame handed out.
//
// A "consumer" is a surface id, or `layer:<id>` for a timeline clip — the same keying every other
// content source uses.
//
// ── WHY CANVAS 2D DRAWS THE GLYPHS ─────────────────────────────────────────────────────────────────
// `fillText` is not a fallback here, it is the feature. It runs Chromium's own HarfBuzz, so kerning,
// ligatures, combining accents, œ, CJK and right-to-left all come out correct for free. Shaping text
// is months of work and the part of "text" that is actually hard; a GPU glyph path would hand us
// back the easy half and make us own the difficult one.
//
// ── AND WHY MOTION IS DRAWN, NOT TRANSFORMED ───────────────────────────────────────────────────────
// This was planned as two stages: raster the glyphs once, then move the result about on the GPU. That
// is the wrong shape for TYPE. Transforming a finished picture — on the GPU or off it — RESAMPLES the
// glyphs, and soft edges are the one failure type cannot survive; a projector on a twelve-metre wall
// is exactly where it shows. Re-drawing the text at its new size and angle keeps it vector-crisp, and
// costs nothing extra to do: `textScale` multiplies the FONT SIZE, so the buffer never changes size
// and there is nothing to resample.
//
// The price is that MOVING text re-rasters per frame (~1 ms for a few lines) where a blit would have
// been cheaper. A STILL surface — which is most of them, most of the time — is cached and free.
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
  // Sample copy, not the word "Text" — a box whose contents read as a LABEL is how the first operator
  // to meet this panel failed to realise it was the input. It has to look like something to replace.
  body: 'Your text here',
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

/** Every field that changes the PIXELS — motion included, because here motion IS drawn (see header). */
function signatureOf(c: SurfaceContent, w: number, h: number): string {
  return [
    c.textBody ?? DEFAULTS.body, c.textFont ?? '', c.textFontAsset ?? '',
    c.textWeight ?? '', c.textItalic ? 'i' : '',
    c.textSize ?? '', c.textLineHeight ?? '', c.textTracking ?? '', c.textAlign ?? '', c.textWrap ? 'w' : '',
    c.textVAlign ?? '', c.textBox ? `${c.textBox.x},${c.textBox.y},${c.textBox.w},${c.textBox.h}` : '',
    c.textColor ?? '', c.textStrokeColor ?? '', c.textStrokeWidth ?? '', `${w}x${h}`,
    c.textX ?? '', c.textY ?? '', c.textScale ?? '', c.textRotate ?? '',
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
/** One laid-out line: its words, their widths, and whether it ends a paragraph. */
export interface Line { words: string[]; widths: number[]; natural: number; last: boolean }

/**
 * Break a paragraph to fit `measure`, greedily — the algorithm every browser and word processor uses.
 *
 * A word longer than the measure gets its own line and overhangs, rather than being broken: hyphenation
 * needs a dictionary per language, and a silently chopped word is worse than one that sticks out.
 */
export function wrapParagraph(g: OffscreenCanvasRenderingContext2D, para: string, measure: number): string[][] {
  const words = para.split(/[ \t]+/).filter(Boolean);
  if (!words.length) return [[]];
  const out: string[][] = [];
  let cur: string[] = [];
  for (const word of words) {
    if (cur.length && g.measureText(cur.join(' ') + ' ' + word).width > measure) { out.push(cur); cur = [word]; }
    else cur.push(word);
  }
  out.push(cur);
  return out;
}

/** Lay the copy out: paragraphs on "\n", wrapped to the measure when asked, words measured once. */
export function layout(g: OffscreenCanvasRenderingContext2D, body: string, wrap: boolean, measure: number): Line[] {
  const mk = (words: string[], last: boolean): Line => {
    const widths = words.map((wd) => g.measureText(wd).width);
    return { words, widths, natural: widths.reduce((a, b) => a + b, 0), last };
  };
  const out: Line[] = [];
  for (const para of body.split('\n')) {
    if (!wrap) { out.push(mk(para.length ? [para] : [], true)); continue; }
    const ls = wrapParagraph(g, para, measure);
    ls.forEach((ws, i) => out.push(mk(ws, i === ls.length - 1)));
  }
  return out;
}

/** The laid-out rectangle in buffer pixels: its size and its centre. */
export interface TextBox { bw: number; bh: number; bcx: number; bcy: number }

/**
 * The box the copy is laid out in, in buffer pixels.
 *
 * No box ⇒ the whole surface, and the numbers reduce EXACTLY to what a surface-wide layout always
 * produced (centre w/2,h/2; size w,h) — which is why adding this field changes nothing for a project
 * that does not set it.
 */
export function boxOf(c: SurfaceContent, w: number, h: number): TextBox {
  const b = c.textBox;
  return {
    bw: Math.max(1, (b ? b.w : 1) * w),
    bh: Math.max(1, (b ? b.h : 1) * h),
    bcx: (b ? b.x + b.w / 2 : 0.5) * w,
    bcy: (b ? b.y + b.h / 2 : 0.5) * h,
  };
}

/** First baseline offset from the box centre, for a block `blockH` tall at font size `px`. */
export function baselineTop(vAlign: 'top' | 'middle' | 'bottom', bh: number, blockH: number, px: number): number {
  const top = vAlign === 'top' ? -bh / 2 : vAlign === 'bottom' ? bh / 2 - blockH : -blockH / 2;
  return top + px * 0.72;   // ~cap height, close enough across families to skip a per-font table
}

function paint(g: OffscreenCanvasRenderingContext2D, c: SurfaceContent, w: number, h: number): void {
  const body = c.textBody ?? DEFAULTS.body;
  // SCALE MULTIPLIES THE FONT SIZE rather than scaling a finished picture — that is what keeps the
  // glyphs crisp at any zoom, and it is free: the buffer stays the same size either way.
  const scale = c.textScale ?? 1;
  const px = Math.max(1, (c.textSize ?? DEFAULTS.size) * scale * h);
  const lineH = (c.textLineHeight ?? DEFAULTS.lineHeight) * px;
  const align = c.textAlign ?? DEFAULTS.align;

  g.font = fontOf(c, px);
  // Chromium supports canvas letterSpacing; older engines ignore the assignment rather than throwing,
  // which degrades to "no tracking" instead of no text. It also feeds measureText, so wrapping and
  // justification account for tracking without being told about it.
  const track = (c.textTracking ?? DEFAULTS.tracking) * px;
  try { (g as unknown as { letterSpacing: string }).letterSpacing = `${track}px`; } catch { /* ignore */ }
  g.textBaseline = 'alphabetic';
  g.lineJoin = 'round';   // a mitre on a tight corner spikes far past the glyph at heavy weights
  g.miterLimit = 2;

  // THE MEASURE IS THE BOX, and the box defaults to the whole surface — which is exactly what every
  // project written before `textBox` gets. Wrapping to the surface is only right when the surface IS
  // the column; a wall carrying a title in one corner and a paragraph down one side needs a measure
  // smaller than the wall.
  //
  // Justify FORCES wrapping: stretching a line the operator chose the length of, out to the full
  // measure, is not justification — it is a mistake that looks like one.
  const justify = align === 'justify';
  const { bw, bh, bcx, bcy } = boxOf(c, w, h);
  const measure = bw;
  const lines = layout(g, body, justify || c.textWrap === true, measure);
  const blockH = lines.length * lineH;
  const stroke = (c.textStrokeWidth ?? DEFAULTS.strokeWidth) * px;
  const ink = () => { g.fillStyle = c.textColor ?? DEFAULTS.color; };
  const halo = stroke > 0;
  if (halo) { g.lineWidth = stroke * 2; g.strokeStyle = c.textStrokeColor ?? DEFAULTS.strokeColor; }

  // The block sits at the middle of the surface, offset by the normalized motion fields and turned
  // about its own centre. Centred is the useful default for type on a mapped surface — a title on a
  // wall is centred far more often than flush to a corner, and flush is one slider away.
  g.save();
  g.translate(bcx + (c.textX ?? 0) * w, bcy + (c.textY ?? 0) * h);
  const rot = c.textRotate ?? 0;
  if (rot) g.rotate((rot * Math.PI) / 180);

  // Draw around (0,0) — now the BOX's centre. 0.72 of the em approximates cap height well enough
  // across families to avoid measuring every one, so a block reads as vertically centred without a
  // per-font table.
  const flushX = -bw / 2;
  // `top` anchors the FIRST baseline to the top of the box, so a paragraph grows downwards as it is
  // typed instead of creeping upwards out of the middle — which is what a real text box wants.
  let y = baselineTop(c.textVAlign ?? 'middle', bh, blockH, px);

  for (const line of lines) {
    // A JUSTIFIED line is drawn word by word, with the slack shared between the gaps. The LAST line of
    // a paragraph is not stretched — a two-word closing line spread across a wall is the classic
    // giveaway of justification done by machine, and every typesetter leaves it flush instead.
    if (justify && !line.last && line.words.length > 1) {
      const gap = (measure - line.natural) / (line.words.length - 1);
      g.textAlign = 'left';
      let cx = flushX;
      for (let i = 0; i < line.words.length; i++) {
        if (halo) g.strokeText(line.words[i], cx, y);
        ink();
        g.fillText(line.words[i], cx, y);
        cx += line.widths[i] + gap;
      }
    } else {
      const text = line.words.join(' ');
      g.textAlign = justify || align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
      const x = g.textAlign === 'left' ? flushX : g.textAlign === 'right' ? bw / 2 : 0;
      if (halo) g.strokeText(text, x, y);
      ink();
      g.fillText(text, x, y);
    }
    y += lineH;
  }
  g.restore();
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
