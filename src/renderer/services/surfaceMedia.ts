import { Surface, SourceType } from '../types';
import { FULL_RECT, type SrcRect } from '../../../shared/protocol';
import { clampRect } from './outputSpan';
import { timeline } from './timeline';
import * as contentSource from './contentSource';

// Owns the media lifecycle for every Surface. The per-type drawable production (one <video>/<img>
// per VIDEO/IMAGE surface, a single live camera/Spout/NDI/DMX-in, effects, tracking) lives in
// services/contentSource, which is shared with the timeline so a layer's content clips reuse the
// exact same producers (and the live receivers are refcounted across surfaces + clips). This module
// just maps surfaces ⇄ contentSource consumer keys and resolves the LAYER source to the timeline.
//
// Stage calls syncSurfaces() when the surfaces change and getDrawable() each frame to composite.

type Drawable = CanvasImageSource;

// Surface ids we currently hold contentSource instances for (so retyped/removed surfaces release).
const acquired = new Set<string>();

// Every surface currently in play, by id. A SLICE has to reach the surface it crops, and getDrawable
// is handed ONE surface (it is called per-surface from four different compositors), so the lookup has
// to live here. syncSurfaces already receives the whole set on every change, which makes this free.
//
// ⚠ A projector window syncs only ITS OWN surface — so main pushes a slice's source surface alongside
// it in the bridge `config` message (see projector/bridge.ts `sources`). Without that a slice of an
// EFFECT/IMAGE could not resolve locally and would fall back to the streamed frame.
const byId = new Map<string, Surface>();

// Reconcile contentSource consumers with the current surfaces.
export function syncSurfaces(surfaces: Surface[], isPlaying: boolean): void {
  const next = new Set<string>();
  let wantProgram = false;
  byId.clear();
  for (const s of surfaces) byId.set(s.id, s);
  for (const s of surfaces) {
    const t = s.content.type;
    if (t === SourceType.PROGRAM) wantProgram = true;
    // NONE/LAYER/PROGRAM are the timeline's; a SLICE owns no media of its own — it borrows the picture
    // of the surface it crops, which is exactly why N slices of one video cost ONE decode.
    if (t === SourceType.NONE || t === SourceType.LAYER || t === SourceType.PROGRAM || t === SourceType.SLICE) continue;
    contentSource.acquire(s.id, s.content);
    next.add(s.id);
  }
  for (const id of acquired) if (!next.has(id)) contentSource.release(id);
  acquired.clear();
  for (const id of next) acquired.add(id);
  for (const id of [...crops.keys()]) if (!byId.has(id)) crops.delete(id); // slice removed/retyped
  contentSource.setPlaying(isPlaying);
  if (wantProgram) timeline.retainProgram('surfaces'); else timeline.releaseProgram('surfaces'); // composite only when consumed
}

// --- SLICE: a cropped region of another surface's picture -----------------------------------------

type Crop = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  gen: number | undefined; // source generation the canvas currently holds (undefined = unknowable)
  rect: SrcRect;
  srcW: number; srcH: number;
};
const crops = new Map<string, Crop>();

// Said once per surface per problem — a broken slice is drawn every frame, and a per-frame console
// spam would bury the message that actually explains the black output.
const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[surfaceMedia] ${msg}`);
}

// Intrinsic pixel size of a drawable. CanvasImageSource is a union with three different spellings of
// "how big are you", so duck-type rather than instanceof (an OffscreenCanvas / VideoFrame from a
// codec plugin is neither an <img> nor a <video>).
function drawableSize(d: CanvasImageSource): { w: number; h: number } | null {
  const a = d as unknown as Record<string, number>;
  const w = a['videoWidth'] || a['naturalWidth'] || a['displayWidth'] || a['width'] || 0;
  const h = a['videoHeight'] || a['naturalHeight'] || a['displayHeight'] || a['height'] || 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

const sameRect = (a: SrcRect, b: SrcRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

// The surface whose picture `s` ultimately shows — itself, unless it is a SLICE, in which case the
// surface it crops. Null when a slice's source is missing or is itself a slice. Pure (takes the list
// rather than reading `byId`) because both the editor window and a projector window ask this about a
// set they hold themselves: main uses it to decide which extra surface to push over the bridge, the
// projector uses it to decide whether it can render the content locally or must be fed frames.
export function resolveSource(s: Surface, all: Surface[]): Surface | null {
  if (s.content.type !== SourceType.SLICE) return s;
  const src = all.find((x) => x.id === s.content.sliceOf);
  if (!src || src.id === s.id || src.content.type === SourceType.SLICE) return null;
  return src;
}

// Resolve a SLICE surface to a canvas holding just its region of the source picture.
//
// Slices stay FLAT by design — a slice of a slice is refused rather than resolved. Nesting buys
// nothing (any sub-region is expressible as one rect on the original) and it is the only way this
// could ever cycle, so refusing it removes the need for cycle detection entirely.
function sliceDrawable(s: Surface): Drawable | null {
  const srcId = s.content.sliceOf;
  if (!srcId) return null;                       // freshly retyped to Slice, no source picked yet
  if (srcId === s.id) { warnOnce(`${s.id}:self`, `surface "${s.name}" slices itself — nothing to show`); return null; }
  const src = byId.get(srcId);
  if (!src) return null;                         // source not in this window's set (or deleted) — stay black
  if (src.content.type === SourceType.SLICE) {
    warnOnce(`${s.id}:nested`, `surface "${s.name}" slices another slice ("${src.name}") — slices don't nest`);
    return null;
  }

  const d = getDrawable(src);                    // depth 1: the source is guaranteed not to be a SLICE
  if (!d) return null;
  const size = drawableSize(d);
  if (!size) return null;                        // source not decoded yet

  const rect = clampRect(s.content.sliceRect ?? FULL_RECT);
  const dw = Math.max(1, Math.round(size.w * rect.w));
  const dh = Math.max(1, Math.round(size.h * rect.h));

  let e = crops.get(s.id);
  if (!e) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    e = { canvas, ctx, gen: undefined, rect, srcW: size.w, srcH: size.h };
    crops.set(s.id, e);
  }
  // A resize clears the canvas, so it always forces a redraw below (never treat it as cached).
  const resized = e.canvas.width !== dw || e.canvas.height !== dh;
  if (resized) { e.canvas.width = dw; e.canvas.height = dh; }

  // Skip the blit when the source is holding the same pixels AND we're cropping the same box out of
  // them. An undefined generation means "unknowable" (live camera, effect, plugin source) → redraw.
  const gen = getDrawableGeneration(src);
  const cached = !resized && gen !== undefined && gen === e.gen && sameRect(rect, e.rect)
    && size.w === e.srcW && size.h === e.srcH;
  if (!cached) {
    try {
      e.ctx.drawImage(d, rect.x * size.w, rect.y * size.h, rect.w * size.w, rect.h * size.h, 0, 0, dw, dh);
    } catch {
      return null; // source not decodable this frame (a <video> mid-seek) — show nothing, try next frame
    }
    e.gen = gen; e.rect = rect; e.srcW = size.w; e.srcH = size.h;
  }
  return e.canvas;
}

// Natural aspect ratio (w/h) of a surface's current content once it's loaded, or null
// if unknown / not applicable. Used by the Stage to fit the surface rect to its media.
/** The synced surface with this id, for consumers that hold only an id (a venue mesh bound to a
 *  surface — see Simulator3D/useSurfaceTexture). Undefined until the first syncSurfaces. */
export function getSurface(id: string | undefined | null): Surface | undefined {
  return id ? byId.get(id) : undefined;
}

export function getContentAspect(s: Surface): number | null {
  // A slice is as wide as its crop of the source, so a 3-wide span of a 16:9 video gives three ~16:5
  // surfaces — which is what the Stage should fit each piece to.
  if (s.content.type === SourceType.SLICE) {
    const src = s.content.sliceOf ? byId.get(s.content.sliceOf) : undefined;
    if (!src || src.content.type === SourceType.SLICE) return null;
    const a = getContentAspect(src);
    if (a == null) return null;
    const r = clampRect(s.content.sliceRect ?? FULL_RECT);
    return (a * r.w) / r.h;
  }
  if (s.content.type === SourceType.PROGRAM) { const { w, h } = timeline.programSize(); return w / h; }
  // LAYER is owned by the timeline, not the content-source registry — without this branch
  // contentSource.getAspect() falls through to the plugin registry, finds nothing, and returns null,
  // so a surface fed by a timeline track never auto-fitted its aspect at all (PROGRAM above already
  // had the same special case; LAYER was simply missed).
  if (s.content.type === SourceType.LAYER) return timeline.getLayerAspect(s.content.layerId);
  return contentSource.getAspect(s.id, s.content);
}

// Changes only when this surface's drawable holds NEW pixels; undefined = unknown, assume changed.
// Only VIDEO surfaces report one — LAYER/PROGRAM composite continuously and everything else is live.
// Used by the projector frame pump to skip a full-surface createImageBitmap on a repeated frame.
export function getDrawableGeneration(s: Surface): number | undefined {
  // A slice holds exactly the pixels of its source, so it repeats exactly when the source does —
  // pass the source's generation through and the projector pump keeps skipping repeated frames.
  if (s.content.type === SourceType.SLICE) {
    const src = s.content.sliceOf ? byId.get(s.content.sliceOf) : undefined;
    return src && src.content.type !== SourceType.SLICE ? getDrawableGeneration(src) : undefined;
  }
  if (s.content.type === SourceType.LAYER || s.content.type === SourceType.PROGRAM) return undefined;
  return contentSource.getDrawableGeneration(s.id, s.content);
}

// Drawable for a surface this frame, or null if not ready / no content.
export function getDrawable(s: Surface): Drawable | null {
  if (s.content.type === SourceType.SLICE) return sliceDrawable(s);
  if (s.content.type === SourceType.LAYER) return timeline.getLayerDrawable(s.content.layerId);
  if (s.content.type === SourceType.PROGRAM) return timeline.getProgramDrawable();
  // ⚠ THE SHOW CLOCK — NOT `performance.now()`.
  //
  // A generative surface used to be handed raw wall time, so it NEVER READ THE TRANSPORT: pausing the show
  // did not freeze the picture, and a seek did not move it. The isPlaying gate above (syncSurfaces ->
  // contentSource.setPlaying) only ever reached the video codecs — an EFFECT is driven by this `timeSec`
  // argument, and wall time does not stop. contentSource.ts documented it as intentional ("clip-local for
  // timeline clips, wall-clock for surfaces"); it is the wrong call for a show-control app, and incoherent
  // with a wave whose whole purpose was to put everything on one transport.
  //
  // Why the SHOW clock and not the playhead: a surface belongs to the SHOW, not to whichever document is
  // bound. showTime survives a scene recall (exactly like the audio bed), so an ambient effect running
  // behind the show keeps running through a GO instead of snapping back to zero. Pause freezes it, a seek
  // scrubs it, Stop resets it.
  //
  // MIRROR WINDOWS DO NOT RUN THIS CLOCK — they are TOLD it, over the transport bridge (see
  // timeline.setExternalShowTime). Without that half, this line would freeze every projector effect at 0,
  // which is worse than the bug it fixes.
  return contentSource.getDrawable(s.id, s.content, timeline.getShowTime());
}

// ── COLD-START READINESS OF THE SURFACES ─────────────────────────────────────────────────────────
// "Which surfaces would composite BLACK right now?" — asked by services/bootGate while the FSM is held
// on a cold project open. A file-backed surface (VIDEO/IMAGE) is ready when its drawable exists;
// getDrawable already encodes exactly that (readyState >= 2 for a <video>, `complete && naturalWidth`
// for an <img>, a decoded frame for a codec), so this is a filter over it, not a second definition.
//
// EVERYTHING ELSE IS READY BY OMISSION, and that is the load-bearing half:
//   · CAMERA / SPOUT / NDI / DMX_IN / TRACKING — a live feed may never arrive (the sending machine is
//     off, the camera is unplugged). Blocking a venue's start on one would hold the house dark.
//   · EFFECT — generative, ready the moment it is asked.
//   · NONE / LAYER / PROGRAM / SLICE — own no media (the timeline's readiness is the pool's, judged by
//     timeline.poolReady; a slice is as ready as the surface it crops).
export function pendingMedia(surfaces: Surface[]): string[] {
  const pending: string[] = [];
  for (const s of surfaces) {
    const t = s.content.type;
    if (t !== SourceType.VIDEO && t !== SourceType.IMAGE) continue;
    if (!s.content.url) continue; // nothing to load — an unconfigured surface is not a reason to wait
    if (contentSource.getDrawable(s.id, s.content, 0)) continue;
    const name = s.content.url.split(/[\\/]/).pop() || s.content.url;
    pending.push(`${s.name || s.id}: ${name}`);
  }
  return pending;
}
