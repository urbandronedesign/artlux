import type { VideoCodecContribution } from '@artlux/sdk/renderer';
import * as hapDecode from './hapDecode';
import * as hapGL from './hapGL';
import * as hapPlayer from './hapPlayer';

// The HAP VideoCodec: wraps the surface player (own clock) + the low-level decode ring / GPU
// BC-decompress for the timeline layer + thumbnail paths. Logic moved verbatim from the former
// host callers (services/hapPlayer for surfaces, timeline's syncHapLayer for layers, thumbnailCache).

// Per-layer GL state (keyed by the layer's GL key) — mirrors the old syncHapLayer `lv.hap` index
// tracking so a frame is re-uploaded to the GPU only when the decoded index actually advances.
const layerState = new Map<string, { index: number; canvas: hapGL.DecodeCanvas | null }>();

export const hapCodec: VideoCodecContribution = {
  id: 'hap',
  canDecode: (path) => hapDecode.isHapCandidate(path),           // .mov (the demux is ISO-BMFF)
  probe: async (path) => (await hapDecode.ensureOpen(path)) !== null, // open native + cache info, no playback
  probed: (path) => hapDecode.isHap(path),                        // true / false / undefined (probing)
  aspect: (path) => hapPlayer.getHapAspect(path),

  // Surface playback — the free-running clock lives in hapPlayer. Returns false for a non-HAP .mov
  // (e.g. H.264) so the surface compositor falls back to a plain <video>.
  openSurface: (path) => hapPlayer.open(path),
  surfaceFrame: (path) => hapPlayer.getHapCanvas(path),
  closeSurface: (path) => hapPlayer.close(path),
  surfaceGeneration: (path) => hapPlayer.getHapGeneration(path),

  // Timeline layer — playhead-driven exact frame (verbatim from syncHapLayer). `layerKey` scopes the
  // GPU canvas (one per layer); the decode ring is shared per file path inside hapDecode.
  layerFrame: (layerKey, path, clipTimeSec) => {
    const info = hapDecode.getInfo(path);
    if (!info) return null;
    const idx = Math.max(0, Math.min(Math.round(clipTimeSec * info.fps), info.frameCount - 1));
    let st = layerState.get(layerKey);
    if (!st) { st = { index: -1, canvas: null }; layerState.set(layerKey, st); }
    const got = hapDecode.getFrame(path, idx);
    if (got && got.index !== st.index) { st.canvas = hapGL.uploadFrame(layerKey, got.frame); st.index = got.index; }
    return st.canvas;
  },
  releaseLayer: (layerKey) => { hapGL.release(layerKey); layerState.delete(layerKey); },
  // The decoded index already tracked above — it advances only on the `got.index !== st.index` branch
  // that actually re-uploads, which is precisely "the canvas has new pixels".
  layerGeneration: (layerKey) => { const st = layerState.get(layerKey); return st && st.index >= 0 ? st.index : undefined; },

  setPlaying: (p) => hapPlayer.setPlaying(p),
  preWarm: (path) => { void hapDecode.ensureOpen(path); },
  // Cold start: fill the decode-ahead ring before the host lets the show run, so playback does not
  // open on an empty buffer (see hapDecode.preRoll and the SDK's contract).
  preRoll: (path, atSec, aheadSec) => hapDecode.preRoll(path, atSec, aheadSec),

  // One-shot decode (bypasses the playback prefetch ring) onto a single dedicated GL canvas — used by
  // the thumbnail cache so scrubbing thumbnails never re-centers a live layer's decode-ahead window.
  thumbnail: async (path, timeSec) => {
    const info = hapDecode.getInfo(path) ?? (await hapDecode.ensureOpen(path));
    if (!info) return null;
    const idx = Math.max(0, Math.min(Math.round(timeSec * info.fps), info.frameCount - 1));
    const frame = await hapDecode.decodeFrameRaw(path, idx);
    return frame ? hapGL.uploadFrame('hap-thumb', frame) : null;
  },
};
