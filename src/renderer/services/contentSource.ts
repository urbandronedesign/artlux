import { SourceType, type SurfaceContent } from '../types';
import { getInputCanvas, startInput, stopInput } from './dmxInput';
import { SurfaceEffect } from '../gpu/surfaceFx';
import { resolveMediaUrl, mimeForPath } from './mediaCache';
import { contentSourceRegistry, videoCodecRegistry } from '../host/registries';

// One registry that turns ANY consumer's content into a drawable, keyed by an arbitrary string
// (surfaces use their id; timeline layers use `layer:<layerId>`). Per-instance producers (video /
// image / effect) live one-per-key; the built-in live receivers (camera / DMX-in) are shared
// single-instance singletons refcounted across all consumers, so they run when EITHER a surface or
// a timeline clip wants them and stop the instant none do. Plugin-contributed live sources (Spout /
// NDI / TRACKING) own the same refcount discipline inside their provider.
//
// surfaceMedia delegates here for surfaces; services/timeline delegates here for content clips.

type Drawable = CanvasImageSource;
type Entry =
  | { type: 'VIDEO'; el: HTMLVideoElement; url: string }
  | { type: 'IMAGE'; el: HTMLImageElement; url: string }
  | { type: 'CODEC'; codecId: string; path: string }; // a plugin VideoCodec (e.g. HAP) decodes this file

const media = new Map<string, Entry>();          // VIDEO / IMAGE / CODEC, keyed by consumer key
const effects = new Map<string, SurfaceEffect>(); // EFFECT, keyed by consumer key

// Shared live receivers, refcounted by consumer key. (Spout + NDI moved to their plugins — same
// refcount pattern, now owned by the content-source providers.)
const cameraConsumers = new Set<string>();
const dmxConsumers = new Set<string>();

// ⚠ CODEC DECODERS ARE SHARED PER FILE PATH — SO THEY MUST BE REFCOUNTED PER CONSUMER.
//
// A plugin VideoCodec keys its surface decoder by PATH, not by consumer: hap `open$`
// (hapManager) and mp4 `decoders` (mp4Decoder) both return the SAME decoder to every consumer
// asking for the same file. That sharing is the point — it is why N surfaces on one clip cost
// one decode, and why HAP survives many simultaneous sources.
//
// But `closeSurface(path)` tears that shared decoder down unconditionally. Keyed by consumer,
// `dropMedia` used to call it the moment ANY one consumer let go — so with two surfaces on the
// same file, deleting or retyping one KILLED THE OTHER'S DECODER. The survivor then went black
// permanently, because reconcileMedia() early-returns when the url is unchanged and never reopens.
//
// So: count the consumers per path here and only close on the last release. This lives in the
// host rather than in each plugin because this module is the only place that knows consumer
// identity — the codec contract is path-based by design and should stay that way.
const codecUsers = new Map<string, Set<string>>(); // codec file path -> consumer keys holding it

function retainCodec(path: string, key: string): void {
  let users = codecUsers.get(path);
  if (!users) { users = new Set(); codecUsers.set(path, users); }
  users.add(key);
}

// Release `key`'s claim on `path`; closes the shared decoder only when nobody is left.
function releaseCodec(codecId: string, path: string, key: string): void {
  const users = codecUsers.get(path);
  if (users) {
    users.delete(key);
    if (users.size > 0) return; // another surface/clip is still playing this file — leave it open
    codecUsers.delete(path);
  }
  videoCodecRegistry.get(codecId)?.closeSurface(path);
}

let cameraEl: HTMLVideoElement | null = null;
let cameraStream: MediaStream | null = null;
let cameraStarting = false;
let dmxActive = false;
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
  if (e.type === 'CODEC') releaseCodec(e.codecId, e.path, key); // shared per path — close only on the last user
  media.delete(key);
}

// Bring this key's per-instance <video>/<img> in line with its content (no-op for live/effect types).
function reconcileMedia(key: string, content: SurfaceContent): void {
  if (content.type === SourceType.VIDEO && content.url) {
    const e = media.get(key);
    const curUrl = e ? (e.type === 'CODEC' ? e.path : e.type === 'VIDEO' ? e.url : null) : null;
    if (curUrl === content.url) return;
    if (e?.type === 'VIDEO') e.el.pause();
    if (e?.type === 'CODEC') releaseCodec(e.codecId, e.path, key); // retyped away — drop this key's claim
    const url = content.url;
    const codec = videoCodecRegistry.forPath(url); // a plugin decoder claims this file (e.g. HAP .mov)
    if (codec) {
      // Optimistically use the codec; its probe downgrades to a normal <video> if it isn't (e.g. an
      // H.264 .mov that isn't HAP).
      media.set(key, { type: 'CODEC', codecId: codec.id, path: url });
      retainCodec(url, key);
      void codec.openSurface(url).then((ok) => {
        if (ok) return;
        const cur = media.get(key);
        if (cur && cur.type === 'CODEC' && cur.path === url) {
          releaseCodec(codec.id, url, key); // not decodable by this codec → hand the file to a <video>
          media.set(key, { type: 'VIDEO', el: makeVideo(url), url });
        }
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
// Loopback DMX-in universes: the legacy 0-7 range (casual/external senders) PLUS every universe a
// patched fixture touches (so a back rig on sACN universe 8+ is mirrored). Derived from fixtures by
// Stage; strictly additive to the old fixed [0..7] set → non-regressing. This only widens sACN's joined
// multicast groups (Art-Net binds one UDP port and was never per-universe-limited).
const DEFAULT_DMX_UNIVERSES = [0, 1, 2, 3, 4, 5, 6, 7];
let dmxUniverses: number[] = DEFAULT_DMX_UNIVERSES;
export function setDmxInputUniverses(universes: number[]): void {
  const next = Array.from(new Set([...DEFAULT_DMX_UNIVERSES, ...universes])).sort((a, b) => a - b);
  if (next.length === dmxUniverses.length && next.every((u, i) => u === dmxUniverses[i])) return;
  dmxUniverses = next;
  if (dmxActive) window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: dmxUniverses }); // re-join live
}

function reconcileDmx(): void {
  const want = dmxConsumers.size > 0;
  if (want === dmxActive) return;
  dmxActive = want;
  if (want) { window.artlux?.configureInput?.({ enabled: true, protocol: 'both', universes: dmxUniverses }); startInput(); }
  else { window.artlux?.configureInput?.({ enabled: false, protocol: 'both', universes: [] }); stopInput(); }
}

// Declare that `key` wants `content` live this frame. Idempotent — safe to call every sync; the
// receiver reconcilers only start/stop on an actual change.
export function acquire(key: string, content: SurfaceContent): void {
  reconcileMedia(key, content);
  if (content.type === 'EFFECT') { if (!effects.has(key)) effects.set(key, new SurfaceEffect()); }
  else effects.delete(key);

  if (content.type === SourceType.CAMERA) cameraConsumers.add(key); else cameraConsumers.delete(key);
  if (content.type === SourceType.DMX_IN) dmxConsumers.add(key); else dmxConsumers.delete(key);

  // Plugin-contributed content sources (e.g. Spout, NDI, TRACKING): hand the key to the matching
  // provider, drop it from the rest (mirrors the per-type add/delete discipline above).
  for (const p of contentSourceRegistry.all()) {
    if (content.type === p.type) p.acquire?.(key, content); else p.release?.(key);
  }

  reconcileCamera(); reconcileDmx();
}

// Drop everything `key` was holding (instance element + receiver refcounts + tracking canvas).
export function release(key: string): void {
  dropMedia(key);
  effects.delete(key);
  cameraConsumers.delete(key); dmxConsumers.delete(key);
  for (const p of contentSourceRegistry.all()) p.release?.(key);
  reconcileCamera(); reconcileDmx();
}

// Global transport toggle — applies to <video> elements + the camera (live receivers ignore it).
export function setPlaying(p: boolean): void {
  playing = p;
  for (const e of media.values()) if (e.type === 'VIDEO') { if (p) e.el.play().catch(() => {}); else e.el.pause(); }
  if (cameraEl) { if (p) cameraEl.play().catch(() => {}); else cameraEl.pause(); }
  for (const c of videoCodecRegistry.all()) c.setPlaying(p);
}

// Drawable for `key`'s content this frame, or null if not ready. `timeSec` drives generative EFFECT
// content. LAYER is handled by the caller.
//
// ⚠ `timeSec` IS A TRANSPORT TIME. IT USED TO BE WALL TIME FOR SURFACES, AND THIS COMMENT SAID SO.
//
// It read: *"clip-local for timeline clips, wall-clock for surfaces"* — and the wall-clock half was the
// bug, not the contract. A surface's effect was handed `performance.now()/1000`, so it NEVER READ THE
// TRANSPORT: pausing the show did not freeze the picture, a seek did not move it, and each window ran its
// own epoch, so the operator's preview and the audience's projector sat at different phases *permanently*.
// Fixed 2026-07-14 (`surfaceMedia.ts`): a surface's effect now rides the **SHOW clock** — pause freezes it,
// a seek scrubs it, Stop resets it, and a scene recall does NOT restart it (an ambient background belongs
// to the show, exactly like the audio bed).
//
// ⚠⚠ AND THIS IS A PLUGIN-FACING CONTRACT, WHICH IS WHY IT MATTERS MORE THAN AN INTERNAL COMMENT.
// `getDrawable` is the `ContentSourceProvider` API (see the registry below): the meaning of the `timeSec`
// a third-party provider receives changed from wall time to show time. Any provider that assumed a
// monotonic, never-pausing clock — and the old comment told them to — is now wrong in a way nothing will
// warn them about. Callers:
//   · timeline clips  → clip-local time (unchanged)
//   · surfaces        → the SHOW clock (`timeline.getShowTime()`), NOT wall time
// It is currently documented nowhere else; docs/SDK.md and docs/PLUGINS.md describe getDrawable without
// naming a clock at all. They should.
export function getDrawable(key: string, content: SurfaceContent, timeSec: number): Drawable | null {
  switch (content.type) {
    case SourceType.VIDEO: {
      const e = media.get(key);
      if (!e) return null;
      if (e.type === 'CODEC') return videoCodecRegistry.get(e.codecId)?.surfaceFrame(e.path) ?? null;
      return e.type === 'VIDEO' && e.el.readyState >= 2 ? e.el : null;
    }
    case SourceType.IMAGE: {
      const e = media.get(key);
      return e && e.type === 'IMAGE' && e.el.complete && e.el.naturalWidth > 0 ? e.el : null;
    }
    case SourceType.CAMERA:
      return cameraEl && cameraEl.readyState >= 2 ? cameraEl : null;
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

// A value that changes only when `key`'s drawable holds NEW pixels, or undefined when that can't be
// known (live receivers, effects, plugin sources) — undefined means "assume it changed". Lets a
// consumer that pays per frame skip repeats; see VideoCodecContribution.surfaceGeneration.
export function getDrawableGeneration(key: string, content: SurfaceContent): number | undefined {
  if (content.type !== SourceType.VIDEO) return undefined;
  const e = media.get(key);
  if (!e) return undefined;
  if (e.type === 'CODEC') return videoCodecRegistry.get(e.codecId)?.surfaceGeneration?.(e.path);
  // A <video> element advances continuously; currentTime is its natural frame identity. Paused or
  // stalled playback repeats the same value, which is exactly what we want to detect.
  return e.type === 'VIDEO' && e.el.readyState >= 2 ? e.el.currentTime : undefined;
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
      if (e?.type === 'CODEC') return videoCodecRegistry.get(e.codecId)?.aspect(e.path) ?? null;
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
