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
  return contentSource.getDrawable(s.id, s.content, performance.now() / 1000);
}
