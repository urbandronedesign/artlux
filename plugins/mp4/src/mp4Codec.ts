import type { VideoCodecContribution } from '@artlux/sdk/renderer';
import * as dec from './mp4Decoder';

// The MP4 VideoCodec — frame-accurate H.264/H.265 via the GPU-accelerated WebCodecs decoder
// (mp4Decoder). DEFAULT ON: `enabled` is pushed from the mp4WebCodecs setting, which is now absent ⇒
// true; turning it off forces every .mp4 back onto a <video> element for the whole machine.
//
// Claiming a file is not the same as being able to decode it. mp4Decoder.open() asks
// VideoDecoder.isConfigSupported() before saying yes, so a track WebCodecs cannot configure declines
// at probe time and the host's existing fallbacks take over — surfaces revert to a <video>, timeline
// layers to syncVideoLayer, thumbnails to the video queue. That check is what made defaulting this on
// safe; without it an unsupported profile demuxed fine and then produced no frames at all.

let enabled = false; // until the setting is pushed on boot — see App's mp4SetEnabled effect
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
  // The decoded frame's own timestamp — changes only when the decoder actually advanced. Consumers
  // that pay per frame (the 3D texture upload, the projector pump's createImageBitmap) skip repeats
  // on it; see mp4Decoder.generation.
  surfaceGeneration: (path) => dec.generation(path),
  closeSurface: (path) => { surfaces.delete(path); dec.close(path); },

  // Timeline layer: playhead-exact, on a DEDICATED per-layer decoder (keyed by layerKey) so a scrub
  // seeks frame-exactly without disturbing the playing surface's decoder, and layers scrub independently.
  layerFrame: (layerKey, path, clipTimeSec) => dec.layerFrame(layerKey, path, clipTimeSec),
  releaseLayer: (layerKey) => dec.releaseLayer(layerKey),
  layerGeneration: (layerKey) => dec.layerGeneration(layerKey),

  setPlaying: (p) => { if (p === playing) return; playing = p; if (p) clockOriginMs = performance.now() - clock * 1000; },
  preWarm: (path) => { void dec.ensureOpen(path); },
  // Open the LAYER decoder ahead of the swap. preWarm above opens the path-keyed SURFACE decoder,
  // which a timeline layer does not use — see ensureLayerOpen for why that gap made the gate's
  // guarantee vacuous for H.264.
  preWarmLayer: (layerKey, path) => dec.ensureLayerOpen(layerKey, path),
  // Cold start: the gate waits for a decoded BUFFER, not a first frame. HAP has answered this since
  // the 167-ring-miss measurement; mp4 — the default codec — did not, so the anti-stutter guarantee
  // silently excluded every .mp4 in every show.
  preRoll: (path, atSec, aheadSec, layerKey) => dec.preRoll(path, atSec, aheadSec, layerKey),
  // What this file is holding, for the host's residency budget. Mostly the encoded samples: open()
  // keeps the whole track resident so seeks are instant, so one warm mp4 clip can be tens or hundreds
  // of megabytes — the difference a pool-counting budget was blind to.
  residentBytes: (path) => dec.residentBytes(path),
  // Thumbnails use a DEDICATED decoder (dec.thumbnail) so a filmstrip scrub never reseeks the playing
  // surface's decoder out from under it — that contention was the old cause of stutter.
  thumbnail: (path, timeSec) => dec.thumbnail(path, timeSec),
};
