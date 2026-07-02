import { ensureBlobUrl, mimeForPath } from './mediaCache';
import { videoCodecRegistry } from '../host/registries';

// Async thumbnail extraction + LRU cache for timeline filmstrips. Frames are decoded at a fixed
// small size (good cache reuse across zoom) and quantized in time so adjacent strip slots share
// frames. Fully decoupled from playback: normal video uses its own offscreen <video> pool (never
// the engine's layer videos); codec files (HAP, …) use the plugin codec's one-shot `thumbnail`
// (own GL context), so it never disturbs the live decode ring or a layer's canvas. The UI never
// blocks — getThumb() returns a cached/nearest frame synchronously and the Filmstrip repaints via onThumb().

const Q = 0.5;          // time quantization (seconds)
const THUMB_W = 160;    // decoded thumbnail size (16:9); drawn scaled into each slot
const THUMB_H = 90;
const MAX = 400;        // LRU bound (≈ 23 MB at 160×90 RGBA)
const VIDEO_MAX = 2;    // concurrent video seeks
const MAX_LOADERS = 6;  // distinct video elements kept around

interface Entry { bmp: ImageBitmap; path: string; qt: number; }
const cache = new Map<string, Entry>(); // key -> entry (insertion order = LRU)
const inFlight = new Set<string>();
const subs = new Set<(path: string) => void>();

const qtime = (t: number) => Math.max(0, Math.round(t / Q) * Q);
const keyOf = (path: string, qt: number) => `${path}@${qt.toFixed(2)}`;

export function onThumb(cb: (path: string) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
const emit = (path: string) => subs.forEach(cb => cb(path));

function store(key: string, e: Entry): void {
  cache.set(key, e);
  while (cache.size > MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.get(oldest)?.bmp.close();
    cache.delete(oldest);
  }
}

// Nearest already-decoded frame for the same path, so the strip shows something immediately.
function nearest(path: string, qt: number): ImageBitmap | undefined {
  let best: ImageBitmap | undefined;
  let bd = Infinity;
  for (const e of cache.values()) {
    if (e.path !== path) continue;
    const d = Math.abs(e.qt - qt);
    if (d < bd) { bd = d; best = e.bmp; }
  }
  return best;
}

// --- video pool ---
class VideoLoader {
  private v = document.createElement('video');
  private ready: Promise<boolean>;
  last = 0;
  constructor(public path: string) {
    this.v.muted = true; this.v.preload = 'auto'; this.v.crossOrigin = 'anonymous';
    this.ready = (async () => {
      const url = await ensureBlobUrl(path, mimeForPath(path));
      if (!url) return false;
      this.v.src = url;
      await new Promise<void>(res => { this.v.onloadeddata = () => res(); this.v.onerror = () => res(); });
      return this.v.readyState >= 1;
    })();
  }
  async grab(qt: number): Promise<ImageBitmap | null> {
    const ok = await this.ready;
    if (!ok) return null;
    await new Promise<void>(res => {
      this.v.onseeked = () => res();
      try { this.v.currentTime = qt; } catch { res(); }
    });
    try { return await createImageBitmap(this.v, { resizeWidth: THUMB_W, resizeHeight: THUMB_H, resizeQuality: 'low' }); }
    catch { return null; }
  }
}
const loaders = new Map<string, VideoLoader>();
let videoBusy = 0;
const videoQueue: { path: string; qt: number; key: string }[] = [];

function getLoader(path: string): VideoLoader {
  let l = loaders.get(path);
  if (!l) {
    l = new VideoLoader(path);
    loaders.set(path, l);
    if (loaders.size > MAX_LOADERS) {
      const oldest = loaders.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== path) loaders.delete(oldest);
    }
  }
  l.last = performance.now();
  return l;
}

function pumpVideo(): void {
  while (videoBusy < VIDEO_MAX && videoQueue.length) {
    const job = videoQueue.shift()!;
    videoBusy++;
    getLoader(job.path).grab(job.qt)
      .then(bmp => { if (bmp) { store(job.key, { bmp, path: job.path, qt: job.qt }); emit(job.path); } })
      .catch(() => {})
      .finally(() => { videoBusy--; inFlight.delete(job.key); pumpVideo(); });
  }
}

// --- codec path (serial; the codec uses its own dedicated GL context so it never clobbers a layer) ---
let codecBusy = false;
const codecQueue: { path: string; qt: number; key: string }[] = [];

async function pumpCodec(): Promise<void> {
  if (codecBusy || !codecQueue.length) return;
  codecBusy = true;
  const job = codecQueue.shift()!;
  try {
    const codec = videoCodecRegistry.forPath(job.path);
    if (!codec || !(await codec.probe(job.path))) { // codec declined (e.g. a non-HAP .mov) → video pool
      videoQueue.push(job); pumpVideo();
    } else {
      const canvas = await codec.thumbnail(job.path, job.qt);
      if (canvas) {
        const bmp = await createImageBitmap(canvas, { resizeWidth: THUMB_W, resizeHeight: THUMB_H, resizeQuality: 'low' });
        store(job.key, { bmp, path: job.path, qt: job.qt });
        emit(job.path);
      }
    }
  } catch { /* ignore */ } finally {
    inFlight.delete(job.key);
    codecBusy = false;
    if (codecQueue.length) void pumpCodec();
  }
}

function schedule(path: string, qt: number, key: string): void {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  if (videoCodecRegistry.forPath(path)) { codecQueue.push({ path, qt, key }); void pumpCodec(); }
  else { videoQueue.push({ path, qt, key }); pumpVideo(); }
}

// Synchronous: the exact thumbnail if cached (refreshing LRU), else the nearest decoded frame for
// this path; kicks off an async decode for the exact frame either way.
export function getThumb(path: string, time: number): ImageBitmap | undefined {
  const qt = qtime(time);
  const key = keyOf(path, qt);
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); return hit.bmp; }
  schedule(path, qt, key);
  return nearest(path, qt);
}

export const THUMB_ASPECT = THUMB_W / THUMB_H;
