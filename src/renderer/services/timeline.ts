import { Timeline, VideoClip, defaultTimeline } from '../types';
import { getBlobUrl, ensureBlobUrl } from './mediaCache';

// Per-window video-layer timeline engine. The single source of playback time so React
// never re-renders per frame (mirrors dmxSignal/livePreview). One <video> per layer
// (track); as the playhead crosses clip boundaries the layer video's source is swapped.
// The main window advances the playhead itself; the Scene window runs in `external` mode
// and is driven by the bridged transport.

type LayerVid = { el: HTMLVideoElement; clipId: string | null; srcPath: string | null };

const layerVideos = new Map<string, LayerVid>();
const subs = new Set<(playhead: number) => void>();

let data: Timeline = defaultTimeline();
let playing = false;
let external = false; // true in the Scene window (playhead set from the bridge)
let playhead = 0;
let lastT = 0;
let raf = 0;

const ensureBlob = (path: string): void => { void ensureBlobUrl(path, 'video/mp4'); };

function getLayerVideo(layerId: string): LayerVid {
  let lv = layerVideos.get(layerId);
  if (!lv) {
    const el = document.createElement('video');
    el.muted = true; el.playsInline = true; el.loop = false; el.crossOrigin = 'anonymous';
    lv = { el, clipId: null, srcPath: null };
    layerVideos.set(layerId, lv);
  }
  return lv;
}

// Topmost clip on a layer covering time t (later clips win on overlap).
function activeClip(layerId: string, t: number): VideoClip | null {
  let found: VideoClip | null = null;
  for (const c of data.clips) {
    if (c.layerId === layerId && t >= c.start && t < c.start + c.duration) found = c;
  }
  return found;
}

function syncLayer(layerId: string, t: number): void {
  const lv = getLayerVideo(layerId);
  const clip = activeClip(layerId, t);
  if (!clip) { if (!lv.el.paused) lv.el.pause(); lv.clipId = null; return; }

  if (lv.srcPath !== clip.path) {
    const url = getBlobUrl(clip.path);
    if (url) { lv.el.src = url; lv.srcPath = clip.path; }
    else { ensureBlob(clip.path); return; } // not loaded yet
  }
  lv.clipId = clip.id;
  const target = t - clip.start + clip.inPoint;
  if (lv.el.readyState >= 1) {
    const drift = Math.abs(lv.el.currentTime - target);
    // Seek when scrubbing/paused, or when playback drifts too far (boundary/load).
    if (!playing || drift > 0.25) { try { lv.el.currentTime = Math.max(0, target); } catch { /* ignore */ } }
  }
  if (playing) { if (lv.el.paused) lv.el.play().catch(() => {}); }
  else if (!lv.el.paused) lv.el.pause();
}

function frame(now: number): void {
  const dt = lastT ? (now - lastT) / 1000 : 0;
  lastT = now;
  if (playing && !external && data.duration > 0) playhead = (playhead + dt) % data.duration;
  for (const l of data.layers) syncLayer(l.id, playhead);
  subs.forEach(cb => cb(playhead));
  raf = requestAnimationFrame(frame);
}

export const timeline = {
  setData(t: Timeline): void {
    data = t;
    for (const c of t.clips) ensureBlob(c.path);
    for (const id of [...layerVideos.keys()]) {
      if (!t.layers.find(l => l.id === id)) { const lv = layerVideos.get(id)!; lv.el.pause(); lv.el.removeAttribute('src'); layerVideos.delete(id); }
    }
  },
  setPlaying(p: boolean): void { playing = p; },
  setExternal(e: boolean): void { external = e; },
  seek(sec: number): void { playhead = Math.max(0, Math.min(sec, data.duration || 0)); },
  getPlayhead(): number { return playhead; },
  getDuration(): number { return data.duration; },
  isPlaying(): boolean { return playing; },
  // The live drawable for a layer (or null when no clip is under the playhead / not ready).
  getLayerDrawable(layerId?: string): HTMLVideoElement | null {
    if (!layerId) return null;
    const lv = layerVideos.get(layerId);
    return lv && lv.clipId && lv.el.readyState >= 2 ? lv.el : null;
  },
  subscribe(cb: (playhead: number) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; },
  start(): void { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } },
};

timeline.start();
