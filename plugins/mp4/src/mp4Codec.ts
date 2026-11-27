import type { VideoCodecContribution } from '@artlux/sdk/renderer';
import type { NativeSource } from '@artlux/sdk/renderer';
import * as dec from './mp4Decoder';

// SDK v2 (E6d) — WHAT THE NATIVE ENGINE DRAWS FOR AN MP4 (it was core's, contentSource.mp4NativeSource). The engine
// decodes the file itself (mf.rs — the same pictures, test:mp4-parity) and converts it as Chromium does, for what was
// MEASURED: an 8-bit NV12 frame, BT.709 matrix and primaries, limited range, the BT.709 or sRGB transfer. Decided on
// THE APP'S OWN current VideoFrame (`frame`, or this surface's), which knows the stream's colour; anything else stays
// the app's with the reason. Before the app has a frame there is nothing to judge: the next document asks again.
// E6i — THE VERDICT IS KEPT PER FILE. It is asked on every link tick; judging it meant DECODING a frame every tick
// (dec.frame(path, clock)) — which, with the engine following the surface clock (surfaceClockUs), was the only thing
// left making the app decode a film the engine decodes and shows itself (measured: the GPU's video decoder 12–17 %
// against 6–8 % app-only, four films). A file's colour space does not change; its first decoded frame decides.
const verdicts = new Map<string, NativeSource>();
function mp4NativeSource(path: string, frame?: unknown): NativeSource {
  if (frame === undefined) {
    const v = verdicts.get(path);
    if (v) return v;
  }
  const r = judge(path, frame);
  // Only a FINAL answer is kept: "no decoded frame yet" / "duration not known yet" are asked again.
  if (frame === undefined && !/yet$/.test('why' in r ? r.why : '')) verdicts.set(path, r);
  return r;
}
function judge(path: string, frame?: unknown): NativeSource {
  const vf = (frame !== undefined ? frame : dec.frame(path, clock)) as VideoFrame | null | undefined;
  if (!vf || typeof (vf as VideoFrame).format === 'undefined') return { kind: 'unsupported', why: 'an MP4 with no decoded frame yet' };
  if (vf.format !== 'NV12') return { kind: 'unsupported', why: `an MP4 decoded as ${vf.format} (the engine draws 8-bit NV12 only)` };
  const cs = vf.colorSpace;
  const ok = cs?.matrix === 'bt709' && cs?.fullRange === false && cs?.primaries === 'bt709' && (cs?.transfer === 'bt709' || cs?.transfer === 'iec61966-2-1');
  if (!ok) return { kind: 'unsupported', why: `an MP4 in colour space ${cs?.matrix}/${cs?.primaries}/${cs?.transfer}/${cs?.fullRange ? 'full' : 'limited'} (the engine draws BT.709 limited range only)` };
  const info = dec.sourceInfo(path);
  if (!info || !(info.durationSec > 0)) return { kind: 'unsupported', why: 'an MP4 whose duration is not known yet' };
  return { kind: 'mp4', path, durUs: info.durationSec * 1e6 };
}

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
  nativeSource: (path, frame) => mp4NativeSource(path, frame),
  // Ahead of the app (E3k): the file and its length; the engine judges the colour space from its own decoder.
  nativeSourceAhead: (path) => { const info = dec.sourceInfo(path); return info && info.durationSec > 0 ? { kind: 'mp4', path, durUs: info.durationSec * 1e6, judge: 'engine' } : null; },
  canDecode: (path) => enabled && /\.(mp4|m4v)$/i.test(path),
  // Index only — it must not open a decoder. It used to (ensureOpen), and nothing owned what it opened,
  // so every probed file stayed resident for the session. See mp4Decoder's index-probe section.
  probe: (path) => dec.probe(path),
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
  // E6i: the free-running surface clock the native engine follows (it picks the frame itself — mf.rs frame_at).
  surfaceClockUs: (path) => (surfaces.has(path) ? Math.round(clock * 1e6) : undefined),
  // E6j: the same clock with no surface playing — where a film of the NEXT scene will be when it appears.
  clockUs: () => Math.round(clock * 1e6),
  closeSurface: (path) => { surfaces.delete(path); verdicts.delete(path); dec.close(path); },

  // Timeline layer: playhead-exact, on a DEDICATED per-layer decoder (keyed by layerKey) so a scrub
  // seeks frame-exactly without disturbing the playing surface's decoder, and layers scrub independently.
  layerFrame: (layerKey, path, clipTimeSec) => dec.layerFrame(layerKey, path, clipTimeSec),
  releaseLayer: (layerKey) => dec.releaseLayer(layerKey),
  layerGeneration: (layerKey) => dec.layerGeneration(layerKey),

  setPlaying: (p) => { if (p === playing) return; playing = p; if (p) clockOriginMs = performance.now() - clock * 1000; },
  // Holds the file's shared PARSE, not a decoder: it used to open a SURFACE decoder (a full copy of the
  // track) that no timeline layer reads. See mp4Decoder.prewarm.
  preWarm: (path) => dec.prewarm(path),
  // Open the LAYER decoder ahead of the swap — the one a timeline layer actually reads. See
  // ensureLayerOpen for why, without it, the gate's guarantee was vacuous for H.264.
  preWarmLayer: (layerKey, path) => dec.preWarmLayer(layerKey, path),
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
  // An exact thumbnail decodes up to a GOP on the same GPU video decoder the show is playing from — so
  // it waits for the transport to stop (see VideoCodecContribution.thumbnailWhilePlaying).
  thumbnailWhilePlaying: false,

  // ── NON-REALTIME: the exact frame, or nothing ──────────────────────────────────────────────────
  // Everything else here may hand back a neighbour rather than stall a show; this one waits. See
  // FileDecoder.frameExact for why mp4 needed a second accessor at all where HAP did not: HAP is
  // random-access per frame, H.264 is a GOP that has to be decoded forward from a keyframe.
  frameExact: (layerKey, path, timeSec) => dec.layerFrameExact(layerKey, path, timeSec),
  // Width/height/fps/duration off the parsed track — what an export needs to size itself, and what
  // a clip needs for its length on drop.
  sourceInfo: (path) => dec.sourceInfo(path),
};
