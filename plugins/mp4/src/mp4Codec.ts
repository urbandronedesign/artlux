import type { VideoCodecContribution } from '@artlux/sdk/renderer';
import * as dec from './mp4Decoder';

// The MP4 VideoCodec — frame-accurate H.264/H.265 via the GPU-accelerated WebCodecs decoder
// (mp4Decoder). OPT-IN: `enabled` is pushed from the mp4WebCodecs setting; while off, canDecode
// returns false so every .mp4 keeps using the default <video> element (unchanged behaviour).

let enabled = false;
export function setEnabled(on: boolean): void { enabled = on; }

// Surface playback clock (free-running; paused via setPlaying) — mirrors hapPlayer's monotonic clock.
let playing = true;
let clock = 0;          // seconds elapsed while playing
let clockOriginMs = 0;  // performance.now() at clock==0 (drift-free)
let raf = 0;
const surfaces = new Set<string>();
function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  if (playing) clock = (now - clockOriginMs) / 1000;
}
function ensureRaf(): void { if (!raf) { clockOriginMs = performance.now() - clock * 1000; raf = requestAnimationFrame(tick); } }

export const mp4Codec: VideoCodecContribution = {
  id: 'mp4-webcodecs',
  canDecode: (path) => enabled && /\.(mp4|m4v)$/i.test(path),
  probe: (path) => dec.ensureOpen(path).then((i) => i !== null),
  probed: (path) => dec.probed(path),
  aspect: (path) => dec.aspect(path),

  // Surface: one decoder per file, driven by the free-running clock. Returns false if the file isn't
  // decodable (→ host falls back to <video>).
  openSurface: async (path) => {
    const info = await dec.ensureOpen(path);
    if (!info) return false;
    surfaces.add(path); ensureRaf();
    return true;
  },
  surfaceFrame: (path) => dec.frame(path, clock),
  closeSurface: (path) => { surfaces.delete(path); dec.close(path); },

  // Timeline layer: playhead-exact. Shares the per-file decoder (one playhead per file); a surface +
  // a layer on the SAME file at different times would contend — rare; a per-consumer decoder is a
  // follow-up. `layerKey` is unused (the decoder is keyed by path).
  layerFrame: (_layerKey, path, clipTimeSec) => dec.frame(path, clipTimeSec),
  releaseLayer: (_layerKey) => { /* decoder is per-path; closed on closeSurface / process teardown */ },

  setPlaying: (p) => { if (p === playing) return; playing = p; if (p) clockOriginMs = performance.now() - clock * 1000; },
  preWarm: (path) => { void dec.ensureOpen(path); },
  // Thumbnails reuse the per-file decoder (a scrub may briefly seek it); good enough for a first cut.
  thumbnail: async (path, timeSec) => { await dec.ensureOpen(path); return dec.frame(path, timeSec); },
};
