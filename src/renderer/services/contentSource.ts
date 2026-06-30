import { SourceType, type SurfaceContent } from '../types';
import { getInputCanvas, startInput, stopInput } from './dmxInput';
import { getSpoutCanvas, startSpout, stopSpout } from './spoutReceiver';
import { getNdiCanvas, startNdi, stopNdi } from './ndiReceiver';
import { SurfaceEffect } from '../gpu/surfaceFx';
import { resolveMediaUrl, mimeForPath } from './mediaCache';
import * as hap from './hapPlayer';
import { contentSourceRegistry } from '../host/registries';

// One registry that turns ANY consumer's content into a drawable, keyed by an arbitrary string
// (surfaces use their id; timeline layers use `layer:<layerId>`). Per-instance producers (video /
// image / effect) live one-per-key; the live receivers (camera / Spout / NDI / DMX-in) are shared
// single-instance singletons refcounted across all consumers, so they run when EITHER a surface or
// a timeline clip wants them and stop the instant none do. The receivers are single-sender: when
// consumers disagree, the most-recently-acquired sender wins (see reconcileSpout/reconcileNdi).
//
// surfaceMedia delegates here for surfaces; services/timeline delegates here for content clips.

type Drawable = CanvasImageSource;
type Entry =
  | { type: 'VIDEO'; el: HTMLVideoElement; url: string }
  | { type: 'IMAGE'; el: HTMLImageElement; url: string }
  | { type: 'HAP'; path: string };

// HAP is carried in QuickTime/MOV; probe those (the parser is ISO-BMFF, not RIFF/.avi).
const isHapCandidate = (url: string): boolean => /\.mov$/i.test(url);

const media = new Map<string, Entry>();          // VIDEO / IMAGE / HAP, keyed by consumer key
const effects = new Map<string, SurfaceEffect>(); // EFFECT, keyed by consumer key

// Shared live receivers, refcounted by consumer key. Spout/NDI carry the desired sender + a seq so
// the latest acquirer wins on conflict.
let seq = 0;
const cameraConsumers = new Set<string>();
const spoutConsumers = new Map<string, { name: string; seq: number }>();
const ndiConsumers = new Map<string, { name: string; seq: number }>();
const dmxConsumers = new Set<string>();

let cameraEl: HTMLVideoElement | null = null;
let cameraStream: MediaStream | null = null;
let cameraStarting = false;
let dmxActive = false;
let spoutActive = false, spoutName = '';
let ndiActive = false, ndiName = '';
let playing = true;

// `url` is a live blob:/http url or an absolute file path (resolved to a blob url via IPC).
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

async function startCamera(): Promise<void> {
  if (cameraStarting || cameraEl) return;
  cameraStarting = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    if (cameraConsumers.size === 0) { stream.getTracks().forEach((t) => t.stop()); return; } // released while awaiting
    cameraStream = stream;
    const v = document.createElement('video');
    v.srcObject = stream; v.muted = true; v.playsInline = true;
    await v.play();
    cameraEl = v;
  } catch (e) {
    const err = e as DOMException;
    console.error(`[contentSource] camera failed: ${err?.name ?? 'Error'} — ${err?.message ?? String(e)}`);
  } finally {
    cameraStarting = false;
  }
}
function stopCamera(): void {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  cameraEl?.pause();
  cameraEl = null;
}

function dropMedia(key: string): void {
  const e = media.get(key);
  if (!e) return;
  if (e.type === 'VIDEO') e.el.pause();
  if (e.type === 'HAP') hap.close(e.path);
  media.delete(key);
}

// Bring this key's per-instance <video>/<img> in line with its content (no-op for live/effect types).
function reconcileMedia(key: string, content: SurfaceContent): void {
  if (content.type === SourceType.VIDEO && content.url) {
    const e = media.get(key);
    const curUrl = e ? (e.type === 'HAP' ? e.path : e.type === 'VIDEO' ? e.url : null) : null;
    if (curUrl === content.url) return;
    if (e?.type === 'VIDEO') e.el.pause();
    if (e?.type === 'HAP') hap.close(e.path);
    const url = content.url;
    if (isHapCandidate(url)) {
      // Optimistically treat as HAP; the probe downgrades to a normal <video> if it isn't.
      media.set(key, { type: 'HAP', path: url });
      void hap.open(url).then((ok) => {
        if (ok) return;
        const cur = media.get(key);
        if (cur && cur.type === 'HAP' && cur.path === url) media.set(key, { type: 'VIDEO', el: makeVideo(url), url });
      });
    } else {
      media.set(key, { type: 'VIDEO', el: makeVideo(url), url });
    }
  } else if (content.type === SourceType.IMAGE && content.url) {
    const e = media.get(key);
    if (!e || e.type !== 'IMAGE' || e.url !== content.url) media.set(key, { type: 'IMAGE', el: makeImage(content.url), url: content.url });
  } else {
    dropMedia(key); // not a media-instance type for this key anymore
  }
}

function reconcileCamera(): void {
  const want = cameraConsumers.size > 0;
  if (want && !cameraEl && !cameraStarting) void startCamera();
  else if (!want && (cameraEl || cameraStream)) stopCamera();
}
function reconcileSpout(): void {
  let want = false, name = '', best = -1;
  for (const v of spoutConsumers.values()) { want = true; if (v.seq > best) { best = v.seq; name = v.name; } }
  if (want !== spoutActive || name !== spoutName) { spoutActive = want; spoutName = name; if (want) startSpout(name); else stopSpout(); }
}
function reconcileNdi(): void {
  let want = false, name = '', best = -1;
  for (const v of ndiConsumers.values()) { want = true; if (v.seq > best) { best = v.seq; name = v.name; } }
  if (want !== ndiActive || name !== ndiName) { ndiActive = want; ndiName = name; if (want) startNdi(name); else stopNdi(); }
}
function reconcileDmx(): void {
  const want = dmxConsumers.size > 0;
  if (want === dmxActive) return;
  dmxActive = want;
  if (want) { window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: [0, 1, 2, 3, 4, 5, 6, 7] }); startInput(); }
  else { window.artlux?.configureInput?.({ enabled: false, protocol: 'both', universes: [] }); stopInput(); }
}

const setSpoutConsumer = (key: string, name: string): void => { const c = spoutConsumers.get(key); if (!c || c.name !== name) spoutConsumers.set(key, { name, seq: ++seq }); };
const setNdiConsumer = (key: string, name: string): void => { const c = ndiConsumers.get(key); if (!c || c.name !== name) ndiConsumers.set(key, { name, seq: ++seq }); };

// Declare that `key` wants `content` live this frame. Idempotent — safe to call every sync; the
// receiver reconcilers only start/stop on an actual change.
export function acquire(key: string, content: SurfaceContent): void {
  reconcileMedia(key, content);
  if (content.type === 'EFFECT') { if (!effects.has(key)) effects.set(key, new SurfaceEffect()); }
  else effects.delete(key);

  if (content.type === SourceType.CAMERA) cameraConsumers.add(key); else cameraConsumers.delete(key);
  if (content.type === SourceType.SPOUT) setSpoutConsumer(key, content.spoutName ?? ''); else spoutConsumers.delete(key);
  if (content.type === SourceType.NDI) setNdiConsumer(key, content.ndiName ?? ''); else ndiConsumers.delete(key);
  if (content.type === SourceType.DMX_IN) dmxConsumers.add(key); else dmxConsumers.delete(key);

  // Plugin-contributed content sources: hand the key to the matching provider, drop it from the
  // rest (mirrors the per-type add/delete discipline above). Empty until a plugin registers one.
  for (const p of contentSourceRegistry.all()) {
    if (content.type === p.type) p.acquire?.(key, content); else p.release?.(key);
  }

  reconcileCamera(); reconcileSpout(); reconcileNdi(); reconcileDmx();
}

// Drop everything `key` was holding (instance element + receiver refcounts + tracking canvas).
export function release(key: string): void {
  dropMedia(key);
  effects.delete(key);
  cameraConsumers.delete(key); spoutConsumers.delete(key); ndiConsumers.delete(key); dmxConsumers.delete(key);
  for (const p of contentSourceRegistry.all()) p.release?.(key);
  reconcileCamera(); reconcileSpout(); reconcileNdi(); reconcileDmx();
}

// Global transport toggle — applies to <video> elements + the camera (live receivers ignore it).
export function setPlaying(p: boolean): void {
  playing = p;
  for (const e of media.values()) if (e.type === 'VIDEO') { if (p) e.el.play().catch(() => {}); else e.el.pause(); }
  if (cameraEl) { if (p) cameraEl.play().catch(() => {}); else cameraEl.pause(); }
  hap.setPlaying(p);
}

// Drawable for `key`'s content this frame, or null if not ready. `timeSec` drives generative EFFECT
// content (clip-local for timeline clips, wall-clock for surfaces). LAYER is handled by the caller.
export function getDrawable(key: string, content: SurfaceContent, timeSec: number): Drawable | null {
  switch (content.type) {
    case SourceType.VIDEO: {
      const e = media.get(key);
      if (!e) return null;
      if (e.type === 'HAP') return hap.getHapCanvas(e.path);
      return e.type === 'VIDEO' && e.el.readyState >= 2 ? e.el : null;
    }
    case SourceType.IMAGE: {
      const e = media.get(key);
      return e && e.type === 'IMAGE' && e.el.complete && e.el.naturalWidth > 0 ? e.el : null;
    }
    case SourceType.CAMERA:
      return cameraEl && cameraEl.readyState >= 2 ? cameraEl : null;
    case SourceType.SPOUT:
      return getSpoutCanvas();
    case SourceType.NDI:
      return getNdiCanvas();
    case SourceType.DMX_IN:
      return getInputCanvas();
    case 'EFFECT': {
      let e = effects.get(key);
      if (!e) { e = new SurfaceEffect(); effects.set(key, e); }
      return e.render(content, timeSec);
    }
    default: {
      const p = contentSourceRegistry.get(content.type); // plugin-contributed type, else NONE / LAYER
      return p ? p.getDrawable(key, content, timeSec) : null;
    }
  }
}

// Natural aspect ratio (w/h) of `key`'s content once loaded, or null if unknown / not applicable.
export function getAspect(key: string, content: SurfaceContent): number | null {
  switch (content.type) {
    case SourceType.IMAGE: {
      const e = media.get(key);
      return e && e.type === 'IMAGE' && e.el.naturalWidth > 0 ? e.el.naturalWidth / e.el.naturalHeight : null;
    }
    case SourceType.VIDEO: {
      const e = media.get(key);
      if (e?.type === 'HAP') return hap.getHapAspect(e.path);
      return e && e.type === 'VIDEO' && e.el.videoWidth > 0 ? e.el.videoWidth / e.el.videoHeight : null;
    }
    case SourceType.CAMERA:
      return cameraEl && cameraEl.videoWidth > 0 ? cameraEl.videoWidth / cameraEl.videoHeight : null;
    default: {
      const p = contentSourceRegistry.get(content.type);
      return p?.getAspect ? p.getAspect(key, content) : null;
    }
  }
}
