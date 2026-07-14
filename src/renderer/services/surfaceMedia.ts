import { Surface, SourceType } from '../types';
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

// Reconcile contentSource consumers with the current surfaces.
export function syncSurfaces(surfaces: Surface[], isPlaying: boolean): void {
  const next = new Set<string>();
  let wantProgram = false;
  for (const s of surfaces) {
    const t = s.content.type;
    if (t === SourceType.PROGRAM) wantProgram = true;
    if (t === SourceType.NONE || t === SourceType.LAYER || t === SourceType.PROGRAM) continue; // handled by the timeline
    contentSource.acquire(s.id, s.content);
    next.add(s.id);
  }
  for (const id of acquired) if (!next.has(id)) contentSource.release(id);
  acquired.clear();
  for (const id of next) acquired.add(id);
  contentSource.setPlaying(isPlaying);
  if (wantProgram) timeline.retainProgram('surfaces'); else timeline.releaseProgram('surfaces'); // composite only when consumed
}

// Natural aspect ratio (w/h) of a surface's current content once it's loaded, or null
// if unknown / not applicable. Used by the Stage to fit the surface rect to its media.
export function getContentAspect(s: Surface): number | null {
  if (s.content.type === SourceType.PROGRAM) { const { w, h } = timeline.programSize(); return w / h; }
  return contentSource.getAspect(s.id, s.content);
}

// Drawable for a surface this frame, or null if not ready / no content.
export function getDrawable(s: Surface): Drawable | null {
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
