import { resolveMediaUrl } from './mediaCache';
import { videoCodecRegistry } from '../host/registries';
import * as bootGate from './bootGate';
import { timeline as engine } from './timeline';

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
// Paths whose thumbnails were refused while the cold-start gate held. A Filmstrip asks from its
// RENDER, so a refusal is permanent unless something repaints it — and a stopped timeline never
// does. Waking them the moment the gate arms is what makes the deferral a delay instead of a loss.
const deferred = new Set<string>();

const qtime = (t: number) => Math.max(0, Math.round(t / Q) * Q);
const keyOf = (path: string, qt: number) => `${path}@${qt.toFixed(2)}`;

export function onThumb(cb: (path: string) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
const emit = (path: string) => subs.forEach(cb => cb(path));

// The gate armed: wake every strip that asked while it was held, so they repaint and re-request.
//
// ⚠ NOT ON THE ARM ITSELF. Releasing the held work at the instant the show starts just MOVES the
// contention onto the first seconds of playback — measured: the frame rate dipped to 35 fps with 45
// long frames in the two seconds after arming, which is precisely the window this whole gate exists
// to protect. The strips wait another beat; nobody is looking at a filmstrip in the first second of a
// show, and the pump below then feeds them one at a time.
const WAKE_DELAY_MS = 2500;
bootGate.subscribe((p) => {
  if (p.booting || deferred.size === 0) return;
  const paths = [...deferred];
  deferred.clear();
  setTimeout(() => { for (const path of paths) emit(path); }, WAKE_DELAY_MS);
});

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
      // Streams now (artlux-media://) instead of blob-reading the whole file to grab one frame. That
      // read is what the housekeeping rules below were written around — one measured startup pulled
      // 99 MB + 127 MB of library video for filmstrips nobody was looking at, at ~20 dropped frames
      // per file. The rules still stand (they also bound decode and GPU work), but their worst input
      // is gone.
      this.v.src = resolveMediaUrl(path);
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
  // The <video> path is still the expensive one — a decode + a GPU readback per frame, on the same
  // hardware the show is using. While a show is running it takes the same one-job-at-a-time,
  // one-per-second budget as the codec path — see nextJobDelay.
  while (videoBusy < (engine.isPlaying() ? 1 : VIDEO_MAX) && videoQueue.length) {
    const wait = nextJobDelay();
    if (wait > 0) { setTimeout(pumpVideo, wait); return; }
    // ⚠ NO NEW LOADER WHILE THE SHOW IS RUNNING.
    //
    // The ORIGINAL reason was that opening one blob-read the entire file over IPC — 99 MB and 127 MB
    // in a measured startup — which stalled main mid-read and cost ~20 dropped frames per file even
    // at one job per second. That specific cost is GONE: loaders stream (artlux-media://) and read
    // only the ranges they seek to.
    //
    // The rule stays, for the reason that survives: a new loader is a new decoder and a new demux of
    // an unfamiliar file, which is a burst of decode + IPC + GPU work at the one moment the frame
    // budget has none to give. An EXISTING loader is free to re-seek, so strips built while stopped
    // keep filling; the rest wait for the transport. Revisit only with a measurement, not by reading
    // the paragraph above and concluding the rule expired with it.
    if (engine.isPlaying() && !loaders.has(videoQueue[0].path)) { setTimeout(pumpVideo, PLAYING_GAP_MS); return; }
    const job = videoQueue.shift()!;
    lastJob = performance.now();
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

// A THUMBNAIL YIELDS TO PLAYBACK. Serial was not enough: back-to-back full-frame decodes go through
// the same native decoder, the same IPC and the same GPU upload the live show is using, so a filmstrip
// filling in 300 slots is a sustained tax on every frame. While the transport is RUNNING they are
// spaced out; stopped (authoring, when the strip is what you are looking at) they run flat out.
const PLAYING_GAP_MS = 1000;
let lastJob = 0;

// How long before the next thumbnail job may start. Zero while the transport is STOPPED — that is
// authoring, when the strip is the thing you are looking at. While it RUNS, one job per second across
// BOTH pumps: a single job is a full-frame decode or a whole-file read, and the measured cost of
// letting them go at it was 11-15 dropped frames per window on an otherwise flat 60 fps.
const nextJobDelay = (): number =>
  (engine.isPlaying() ? Math.max(0, PLAYING_GAP_MS - (performance.now() - lastJob)) : 0);

async function pumpCodec(): Promise<void> {
  if (codecBusy || !codecQueue.length) return;
  const wait = nextJobDelay();
  if (wait > 0) { setTimeout(() => { void pumpCodec(); }, wait); return; }
  lastJob = performance.now();
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
  // A FILMSTRIP NEVER COMPETES WITH A SHOW STARTING. Both paths below are expensive in exactly the way
  // a cold start cannot afford: the codec path decodes a full frame per slot, and the <video> path
  // reads the WHOLE FILE over IPC to seek in it (measured: 99 MB + 127 MB of library video read during
  // one startup, for strips nobody was looking at yet, while the playback decode ring sat starved).
  // The gate releases in a second or two, and `deferred` below is what brings the strips back — a
  // Filmstrip only re-asks when something makes it repaint, and a paused timeline repaints nothing.
  if (bootGate.isBooting()) { deferred.add(path); return; }
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
