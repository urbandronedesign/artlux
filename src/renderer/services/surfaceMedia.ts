import { Surface, SourceType } from '../types';
import { getInputCanvas, startInput, stopInput } from './dmxInput';
import { getSpoutCanvas, startSpout, stopSpout } from './spoutReceiver';
import { SurfaceEffect } from '../gpu/surfaceFx';
import { timeline } from './timeline';
import { resolveMediaUrl, mimeForPath } from './mediaCache';

// Owns the media lifecycle for every Surface: one <video>/<img> per VIDEO/IMAGE
// surface, plus a single live camera / Spout / DMX-in (one live at a time, v1).
// Stage calls syncSurfaces() when the surfaces change and getDrawable() each
// frame to composite. Decouples media plumbing from React refs.

type Drawable = CanvasImageSource;
type Entry = { type: 'VIDEO'; el: HTMLVideoElement; url: string } | { type: 'IMAGE'; el: HTMLImageElement; url: string };

const media = new Map<string, Entry>(); // keyed by surface id
const effects = new Map<string, SurfaceEffect>(); // EFFECT surfaces, keyed by id
let cameraEl: HTMLVideoElement | null = null;
let cameraStream: MediaStream | null = null;
let cameraOwner: string | null = null;
let dmxActive = false;
let spoutActive = false;
let spoutName = '';
let playing = true;

// `url` is a live blob:/http url or an absolute file path (resolved to a blob url via IPC).
// The element is created synchronously; its src is set once the (possibly async) url resolves.
function makeVideo(url: string): HTMLVideoElement {
  const v = document.createElement('video');
  v.loop = true; v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
  void resolveMediaUrl(url, 'video/mp4').then((src) => {
    v.src = src; v.load();
    if (playing) v.play().catch(() => {});
  });
  return v;
}
function makeImage(url: string): HTMLImageElement {
  const i = document.createElement('img');
  i.crossOrigin = 'anonymous';
  void resolveMediaUrl(url, mimeForPath(url)).then((src) => { i.src = src; });
  return i;
}

async function startCamera(ownerId: string): Promise<void> {
  cameraOwner = ownerId;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    cameraStream = stream;
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true;
    await v.play();
    cameraEl = v;
  } catch (e) {
    const err = e as DOMException;
    console.error(`[surfaceMedia] camera failed: ${err?.name ?? 'Error'} — ${err?.message ?? String(e)}`);
  }
}
function stopCamera(): void {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraEl?.pause();
  cameraEl = null;
  cameraOwner = null;
}

// Reconcile media elements + live sources with the current surfaces.
export function syncSurfaces(surfaces: Surface[], isPlaying: boolean): void {
  playing = isPlaying;
  const seen = new Set<string>();
  const seenEffects = new Set<string>();
  let wantCamera: string | null = null;
  let wantDmx = false;
  let wantSpout = false;
  let wantSpoutName = '';

  for (const s of surfaces) {
    const c = s.content;
    if (c.type === SourceType.VIDEO && c.url) {
      seen.add(s.id);
      const e = media.get(s.id);
      if (!e || e.type !== 'VIDEO' || e.url !== c.url) {
        if (e && e.type === 'VIDEO') e.el.pause();
        media.set(s.id, { type: 'VIDEO', el: makeVideo(c.url), url: c.url });
      }
    } else if (c.type === SourceType.IMAGE && c.url) {
      seen.add(s.id);
      const e = media.get(s.id);
      if (!e || e.type !== 'IMAGE' || e.url !== c.url) {
        media.set(s.id, { type: 'IMAGE', el: makeImage(c.url), url: c.url });
      }
    } else if (c.type === SourceType.CAMERA) {
      if (!wantCamera) wantCamera = s.id; // first camera surface owns the single live camera
    } else if (c.type === SourceType.DMX_IN) {
      wantDmx = true;
    } else if (c.type === SourceType.SPOUT) {
      wantSpout = true; wantSpoutName = c.spoutName ?? '';
    } else if (c.type === 'EFFECT') {
      seenEffects.add(s.id);
    }
  }

  // Drop media for removed / retyped surfaces.
  for (const [id, e] of media) {
    if (!seen.has(id)) {
      if (e.type === 'VIDEO') e.el.pause();
      media.delete(id);
    }
  }
  for (const id of effects.keys()) if (!seenEffects.has(id)) effects.delete(id);

  // Single live camera.
  if (wantCamera !== cameraOwner) {
    stopCamera();
    if (wantCamera) void startCamera(wantCamera);
  }

  // Apply play/pause to all video elements + the camera.
  for (const e of media.values()) {
    if (e.type === 'VIDEO') { if (playing) e.el.play().catch(() => {}); else e.el.pause(); }
  }
  if (cameraEl) { if (playing) cameraEl.play().catch(() => {}); else cameraEl.pause(); }

  // DMX-in (single live).
  if (wantDmx !== dmxActive) {
    dmxActive = wantDmx;
    if (wantDmx) {
      window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: [0, 1, 2, 3, 4, 5, 6, 7] });
      startInput();
    } else {
      window.artlux?.configureInput?.({ enabled: false, protocol: 'both', universes: [] });
      stopInput();
    }
  }

  // Spout (single live).
  if (wantSpout !== spoutActive || wantSpoutName !== spoutName) {
    spoutActive = wantSpout; spoutName = wantSpoutName;
    if (wantSpout) startSpout(wantSpoutName); else stopSpout();
  }
}

// Natural aspect ratio (w/h) of a surface's current content once it's loaded, or null
// if unknown / not applicable. Used by the Stage to fit the surface rect to its media.
export function getContentAspect(s: Surface): number | null {
  switch (s.content.type) {
    case SourceType.IMAGE: {
      const e = media.get(s.id);
      return e && e.type === 'IMAGE' && e.el.naturalWidth > 0 ? e.el.naturalWidth / e.el.naturalHeight : null;
    }
    case SourceType.VIDEO: {
      const e = media.get(s.id);
      return e && e.type === 'VIDEO' && e.el.videoWidth > 0 ? e.el.videoWidth / e.el.videoHeight : null;
    }
    case SourceType.CAMERA:
      return cameraOwner === s.id && cameraEl && cameraEl.videoWidth > 0 ? cameraEl.videoWidth / cameraEl.videoHeight : null;
    default:
      return null; // EFFECT / SPOUT / DMX_IN / NONE — no intrinsic aspect to fit
  }
}

// Drawable for a surface this frame, or null if not ready / no content.
export function getDrawable(s: Surface): Drawable | null {
  switch (s.content.type) {
    case SourceType.VIDEO: {
      const e = media.get(s.id);
      return e && e.type === 'VIDEO' && e.el.readyState >= 2 ? e.el : null;
    }
    case SourceType.IMAGE: {
      const e = media.get(s.id);
      return e && e.type === 'IMAGE' && e.el.complete && e.el.naturalWidth > 0 ? e.el : null;
    }
    case SourceType.CAMERA:
      return cameraOwner === s.id && cameraEl && cameraEl.readyState >= 2 ? cameraEl : null;
    case SourceType.SPOUT:
      return getSpoutCanvas();
    case SourceType.DMX_IN:
      return getInputCanvas();
    case SourceType.LAYER:
      return timeline.getLayerDrawable(s.content.layerId);
    case 'EFFECT': {
      let e = effects.get(s.id);
      if (!e) { e = new SurfaceEffect(); effects.set(s.id, e); }
      return e.render(s.content, performance.now() / 1000);
    }
    default:
      return null; // NONE
  }
}
