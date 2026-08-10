// Per-consumer state for SHADER content: which source, at what size, and the last frame handed out.
//
// A "consumer" is a surface id, or `layer:<id>` for a timeline clip — the same keying every other
// content source uses. All of them share the ONE context in shaderContext.ts; what lives here is the
// bookkeeping that lets N of them coexist on it, plus the two rules that keep a live show alive: a
// broken edit never blacks out a wall, and a shader that will not behave stops being drawn.

import type { SurfaceContent } from '@/types';
import { getSurface } from '@/services/surfaceMedia'; // host service (transitional runtime seam, as in augmentaDrawable)
import { reportFault } from '@/services/faultReporter';
import { getProgram, renderToBitmap, failedProgram, dropHistory, type CompiledProgram } from './shaderContext';
import { sourceOf } from './shaderSource';
import { lintLoops, noteDraw, isDisabled, rearm, BUDGET } from './shaderGuard';
import { resolve as resolveParams } from './shaderParams';

/** Detail rungs offered in the MAIN window — a PIXEL BUDGET each, not a literal size (see sizeFor). */
export const RENDER_HEIGHTS = [360, 720, 1080] as const;
export const DEFAULT_HEIGHT = 720;

interface Entry {
  bitmap: ImageBitmap | null;
  /** Everything that determines the pixels. Equal signature ⇒ the last bitmap is still correct. */
  sig: string;
  /** THE LAST SOURCE THAT COMPILED. What a broken edit falls back to — see resolveProgram. */
  lastGoodSource: string | null;
}

const entries = new Map<string, Entry>();

/**
 * THE BUFFER TAKES THE SURFACE'S SHAPE.
 *
 * The compositor draws a surface's drawable with `ctx.drawImage(d, x, y, w, h)` (frameEngine.ts) — it
 * STRETCHES the picture into the surface rect, which is what mapping means. So the buffer's aspect has
 * to equal the surface's, or the picture is distorted by however much the two disagree. Mapping space
 * is a unit square (the composite canvas is 512×512), so a surface 0.30 wide and 0.52 high really is
 * portrait, and a 16:9 buffer stretched into it squashed the picture nearly 3×.
 *
 * `shaderRes` therefore names a PIXEL BUDGET: the ladder's 720 means "as many pixels as 1280×720",
 * spent in whatever proportion this surface actually has. `iAspect` reports the same ratio.
 *
 * Dimensions are quantised to 16px. Resizing this canvas reallocates its drawing buffer — the thing
 * that killed the GPU process at 4K in the Phase 0 bench — and a surface being DRAGGED changes shape
 * every frame. Quantising means a drag crosses a size boundary occasionally instead of continuously.
 */
/**
 * WHICH WINDOW THIS IS, because the answer changes what a shader is drawn at.
 *
 * The main window feeds the mapper, whose atlas rect is scaled to fixture density and discards
 * anything finer — 720p there is generous. A projector window feeds a physical projector, where the
 * picture's detail is what an audience sees, so it renders at the OUTPUT's own pixel count. Same
 * source text, same parameters, two very different rasters: that is the whole point of shipping the
 * text between windows rather than the pixels.
 */
let windowKind: 'main' | 'projector' = 'main';
export function setWindowKind(kind: 'main' | 'projector'): void { windowKind = kind; }

const QUANT = 16;
const MIN_DIM = 64;
const MAX_DIM = 3840;

export function sizeFor(res: number, aspect: number): { w: number; h: number } {
  // A projector window IS its output — fullscreen on the display it is bound to — so its own inner
  // size is the native raster, with no need to ask the host for it. The 4K ceiling that the main
  // window keeps does not apply here: what made 4K dangerous was RESIZING the shared canvas every
  // frame when surfaces disagree about size, and in a projector window every surface is the output
  // size, so the canvas is allocated once and never thrashes.
  const budget = windowKind === 'projector' && typeof window !== 'undefined'
    ? Math.max(1, window.innerWidth) * Math.max(1, window.innerHeight)
    : res * ((res * 16) / 9);
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const q = (v: number) => Math.min(MAX_DIM, Math.max(MIN_DIM, Math.round(v / QUANT) * QUANT));
  return { w: q(Math.sqrt(budget * a)), h: q(Math.sqrt(budget / a)) };
}

/**
 * The surface's aspect in mapping space, or 16:9 when there is no surface to ask.
 *
 * `surfaceMedia.getSurface` is fed by `syncSurfaces`, which BOTH the main window and every projector
 * window call — so this one lookup works in both, where `host.surfaces` is inert in a projector.
 */
export function aspectFor(key: string): number {
  const s = getSurface(key);
  return s && s.width > 0 && s.height > 0 ? s.width / s.height : 16 / 9;
}

/**
 * Compile, with the lint in front and the last good program behind.
 *
 * The lint runs BEFORE the driver sees the text, because the whole point is that the dangerous shapes
 * never reach it. Its findings are shaped like compile errors so the editor's gutter needs no second
 * code path.
 */
export function compile(source: string): CompiledProgram {
  const problems = lintLoops(source);
  if (problems.length) {
    return failedProgram(problems.map((p) => `ERROR: 0:${p.line}: ${p.message}`).join('\n'));
  }
  return getProgram(source);
}

/**
 * A TYPO MUST NOT BLACK OUT A WALL.
 *
 * While a shader is being edited its text is broken most of the time — that is what editing is. If a
 * failed compile stopped the picture, every keystroke's worth of half-written code would put a hole in
 * the show, and the one place an author is most likely to be typing is a machine that is running one.
 * So a failure keeps the LAST SOURCE THAT COMPILED and reports the error beside the editor instead.
 *
 * A shader that has NEVER compiled has nothing to fall back to and renders black — which is honest,
 * and the panel says why.
 */
function resolveProgram(key: string, entry: Entry, source: string): { result: CompiledProgram; usingFallback: boolean } {
  const fresh = compile(source);
  if (fresh.ok) { entry.lastGoodSource = source; return { result: fresh, usingFallback: false }; }
  if (entry.lastGoodSource) {
    const good = getProgram(entry.lastGoodSource);
    if (good.ok) return { result: good, usingFallback: true };
  }
  return { result: fresh, usingFallback: false };
}

/**
 * THE REPEAT-CALL GUARD, and it is not an optimisation.
 *
 * The frame engine asks for a surface's drawable, and then the 3D viewport asks again in its own loop —
 * `surfaceFx.ts` documents hitting exactly this. Here it is sharper: `transferToImageBitmap` clears the
 * canvas, so the first caller's bitmap would be a frame the second never sees, and every consumer past
 * the first would pay a full re-render. Same signature in, same bitmap out.
 */
export function getFor(key: string, content: SurfaceContent, timeSec: number): ImageBitmap | null {
  const prev = entries.get(key);

  // A surface disabled for overrunning its budget keeps its last picture rather than going black: the
  // operator sees a frozen wall and a fault, which is a diagnosable state, where black is not.
  if (isDisabled(key)) return prev?.bitmap ?? null;

  const source = sourceOf(content);
  const { w, h } = sizeFor(content.shaderRes ?? DEFAULT_HEIGHT, aspectFor(key));
  // Parameter values join the signature: a slider move must invalidate the cached frame, and it is
  // the only thing besides time that can change the picture without the source changing.
  const values = resolveParams(key, content);
  const paramSig = values ? JSON.stringify([...values.entries()]) : '';
  const sig = `${source.length}:${content.shaderId ?? ''}|${w}x${h}|${timeSec}|${paramSig}`;
  if (prev && prev.sig === sig && prev.bitmap) return prev.bitmap;

  const entry: Entry = prev ?? { bitmap: null, sig: '', lastGoodSource: null };
  const { result } = resolveProgram(key, entry, source);
  if (!result.ok) { entry.sig = sig; entries.set(key, entry); return entry.bitmap; }

  const t0 = performance.now();
  const bmp = renderToBitmap(result, w, h, timeSec, values, key);
  const ms = performance.now() - t0;
  if (!bmp) return entry.bitmap;

  if (noteDraw(key, ms)) {
    // Disabled: say so once, loudly, through the same channel every other renderer fault uses.
    reportFault({
      window: 'main',
      scope: 'shader',
      pluginId: 'shader',
      message: `Shader on ${key} disabled after ${BUDGET.strikes} frames over ${BUDGET.ms} ms — `
        + 'the surface keeps its last picture. Simplify it or lower its Detail, then recompile to re-arm.',
    });
  }

  entry.bitmap?.close(); // the frame we handed out last time; skipping this leaks one bitmap per frame
  entry.bitmap = bmp;
  entry.sig = sig;
  entries.set(key, entry);
  return bmp;
}

/** Compile state for the inspector and the editor's gutter. */
export function compileStatus(content: SurfaceContent): { ok: boolean; log: string; usingFallback: boolean } {
  const source = sourceOf(content);
  const result = compile(source);
  return { ok: result.ok, log: result.log, usingFallback: !result.ok };
}

/** An edit landed: give a previously disabled surface another chance. */
export function rearmKey(key: string): void { rearm(key); }

/** A consumer stopped needing shader content. Drop its bitmap; programs are shared and stay cached. */
export function release(key: string): void {
  entries.get(key)?.bitmap?.close();
  entries.delete(key);
  dropHistory(key); // a feedback buffer is a full-resolution texture; it must not outlive its surface
  rearm(key);
}
