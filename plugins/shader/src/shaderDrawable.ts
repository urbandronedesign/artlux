// Per-consumer state for SHADER content: which program, at what size, and the last frame handed out.
//
// A "consumer" is a surface id, or `layer:<id>` for a timeline clip — the same keying every other
// content source uses. All of them share the ONE context in shaderContext.ts; what lives here is the
// bookkeeping that lets N of them coexist on it.

import type { SurfaceContent } from '@/types';
import { getProgram, renderToBitmap } from './shaderContext';
import { starterSource, DEFAULT_STARTER } from './starters';

/**
 * Render heights offered in the MAIN window. Width follows at 16:9 — see `sizeFor`.
 *
 * 2160 IS DELIBERATELY ABSENT, and it was measured out rather than argued out. Changing this canvas's
 * size reallocates its drawing buffer, so a project mixing render sizes reallocates every frame; at
 * 4K on Intel Iris Xe that thrash **killed the GPU process** (exit_code=34) inside a few seconds —
 * reproducibly, twice, with no hostile shader involved. Every compile afterwards failed with an empty
 * info log, which is the worst possible shape: black surfaces and nothing to read. At 1080p the same
 * loop is survivable (~2.4–3.2 ms/frame) and at 720p it is cheap.
 *
 * Nothing is lost. The LED path uploads into an atlas rect scaled to fixture density and discards
 * anything finer (WebGPUMapper.ts:653), so >1080p in this window was already being thrown away — and
 * the case that genuinely wants 4K is a projector output, which renders in its OWN window and its own
 * context where every surface is the same size and no per-frame resize happens (Phase 6).
 */
export const RENDER_HEIGHTS = [360, 720, 1080] as const;
export const DEFAULT_HEIGHT = 720;

interface Entry {
  bitmap: ImageBitmap | null;
  /** Everything that determines the pixels. Equal signature ⇒ the last bitmap is still correct. */
  sig: string;
}

const entries = new Map<string, Entry>();

function sizeFor(h: number): { w: number; h: number } {
  return { w: Math.round((h * 16) / 9), h };
}

/**
 * THE REPEAT-CALL GUARD, and it is not an optimisation.
 *
 * The frame engine asks for a surface's drawable, and then the 3D viewport asks again in its own loop —
 * `surfaceFx.ts` documents hitting exactly this and caching on the same grounds. Here it is sharper
 * than waste: `transferToImageBitmap` CLEARS the canvas, so a second render for the same frame would
 * be fine, but the first caller's bitmap would then be a frame the second caller never sees, and every
 * consumer past the first would pay a full re-render. Same signature in, same bitmap out.
 */
export function getFor(key: string, content: SurfaceContent, timeSec: number): ImageBitmap | null {
  const shaderId = content.shaderId ?? DEFAULT_STARTER;
  const { w, h } = sizeFor(content.shaderRes ?? DEFAULT_HEIGHT);
  const sig = `${shaderId}|${w}x${h}|${timeSec}`;

  const prev = entries.get(key);
  if (prev && prev.sig === sig && prev.bitmap) return prev.bitmap;

  const entry = getProgram(starterSource(shaderId));
  if (!entry.ok) {
    // A shader that has never compiled has nothing to fall back TO, so the surface goes black and the
    // inspector says why (compileStatus below). Once an author can edit source (Phase 2) the rule
    // inverts: a failed compile keeps the LAST GOOD program, because a typo saved during a show must
    // cost an error message and not the wall.
    return prev?.bitmap ?? null;
  }

  const bmp = renderToBitmap(entry, w, h, timeSec);
  if (!bmp) return prev?.bitmap ?? null;

  // Close the frame we handed out last time. Safe because consumers use a drawable within the frame
  // they asked for it; holding one across frames was never part of the contract (a <video> element's
  // pixels change under the same assumption). Skipping this leaks a full-resolution bitmap per frame.
  prev?.bitmap?.close();
  entries.set(key, { bitmap: bmp, sig });
  return bmp;
}

/** Compile state for the inspector — Phase 0's entire error UI. */
export function compileStatus(content: SurfaceContent): { ok: boolean; log: string } {
  const e = getProgram(starterSource(content.shaderId ?? DEFAULT_STARTER));
  return { ok: e.ok, log: e.log };
}

/** A consumer stopped needing shader content. Drop its bitmap; programs are shared and stay cached. */
export function release(key: string): void {
  entries.get(key)?.bitmap?.close();
  entries.delete(key);
}
