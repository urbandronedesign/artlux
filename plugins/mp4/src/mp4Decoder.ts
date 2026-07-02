import MP4Box, { type MP4File, type MP4Info, type MP4Sample, type MP4VideoTrack } from 'mp4box';
import { resolveMediaUrl } from '@/services/mediaCache'; // host: absolute path → blob: URL (transitional seam)

// High-performance, GPU-accelerated MP4 (H.264/H.265) decode via WebCodecs.
//
// Design (why it's fast + smooth):
//  • mp4box demuxes the container ONCE into encoded samples (H.264/H.265 NAL units) — those are tiny
//    (compressed), so keeping the whole track's samples in RAM is cheap; we never eager-decode.
//  • `VideoDecoder` runs with `hardwareAcceleration: 'prefer-hardware'`, so decode uses the GPU's
//    fixed-function video block (NVDEC/…) — no CPU decode, no H.264 hardware-*session* cap the way a
//    <video> element has, so many surfaces/layers can run at once.
//  • Decode is DECOUPLED from presentation. `frame()` just records the wanted playhead time and picks
//    the nearest already-decoded frame — it never blocks on decode. A windowed *pump* (run from the
//    same call, but the decoder works asynchronously in its worker between calls) keeps a small window
//    of frames decoded AHEAD of the playhead. That is the whole fix for the old choppiness: the pull-
//    based decoder used to grind forward one GOP at a time and fall hopelessly behind a free-running
//    wall clock. Now the buffer stays ahead and getDrawable is O(buffer).
//  • We re-seek to a keyframe ONLY on a backward jump (loop wrap / scrub) or when the playhead has
//    actually caught up to what we've fed (a big forward jump). We do NOT reset at every GOP boundary
//    during normal playback — the decoder swallows mid-stream keyframes as ordinary chunks, so forward
//    play is reset-free and seamless.
//  • `frame()` returns the `VideoFrame` DIRECTLY — a VideoFrame is a `CanvasImageSource`, so the
//    WebGPU/WebGL compositor uploads it straight to a texture (zero CPU copy). Returned frames stay
//    alive in the buffer until evicted, covering async consumers (NDI capture / projector streaming)
//    that read the drawable after the tick.
//
// WebCodecs is a Chromium renderer API (present in the Electron renderer). If it or the codec is
// unavailable, open() resolves null and the host falls back to a plain <video> element.

// Decoded-frame accounting is deliberately SMALL. A hardware VideoDecoder (NVDEC/…) has a fixed, small
// pool of output surfaces — at 4K each held VideoFrame is a ~12 MB GPU surface, and holding many exhausts
// that pool so the decoder BLOCKS (the cause of 4K judder). So we keep only a few decoded frames live,
// retire past ones immediately (freeing surfaces), and pace feeding to stay just a few frames ahead. The
// ENCODED sample look-ahead is separate and cheap; only decoded frames are scarce.
const TARGET_AHEAD = 5;  // decoded (or in-flight) frames to keep ahead — must exceed the B-frame reorder
                         // depth (≤4 for H.264) or the decoder never emits its first frame (startup stall)
const KEEP_BEHIND = 1;   // decoded past frames to retain (present frame + async-consumer slack)
const MAX_BUFFER = 12;   // safety cap on live VideoFrames (paced feeding keeps us well under this)
const QUEUE_BUDGET = 8;  // in-flight chunk cap — ≥ TARGET_AHEAD so we can actually reach the target depth

interface Info { width: number; height: number; durationSec: number; }
interface Enc { ts: number; dur: number; key: boolean; data: Uint8Array } // decode order, µs timestamps

// Extract the codec-private description (avcC / hvcC / …) box bytes for VideoDecoder.configure.
function codecDescription(file: MP4File, trackId: number): Uint8Array | undefined {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const trak: any = (file as any).getTrackById(trackId);
  for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const DataStream: any = (MP4Box as any).DataStream;
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // strip the 8-byte box header
    }
  }
  return undefined;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

class FileDecoder {
  private decoder: VideoDecoder | null = null;
  private cfg: VideoDecoderConfig | null = null;
  private samples: Enc[] = [];      // ALL encoded samples in DECODE order — cheap; decoded on demand
  private keyframes: number[] = []; // decode-order indices in samples[] that are keyframes (ascending)
  private buffer: VideoFrame[] = []; // decoded frames (GPU), sorted by presentation timestamp
  private info: Info | null = null;
  private segStart = -1;   // keyframe sample index the decoder was last (re)started from (-1 = idle)
  private fedTo = -1;      // last sample index fed to the decoder since the last seek (decode order)
  private wantUs = 0;      // latest requested presentation time (µs), looped into [0, dur)

  async open(path: string): Promise<Info | null> {
    if (typeof VideoDecoder === 'undefined') return null; // WebCodecs unavailable
    const url = await resolveMediaUrl(path, 'video/mp4');
    if (!url) return null;
    let buf: ArrayBuffer;
    try { buf = await (await fetch(url)).arrayBuffer(); } catch { return null; }

    return await new Promise<Info | null>((resolve) => {
      const file: MP4File = MP4Box.createFile();
      let settled = false;
      const done = (v: Info | null) => { if (!settled) { settled = true; resolve(v); } };
      file.onError = () => done(null);

      file.onReady = (mp4: MP4Info) => {
        const track: MP4VideoTrack | undefined = mp4.videoTracks?.[0];
        if (!track) return done(null);
        this.info = {
          width: track.video.width, height: track.video.height,
          durationSec: mp4.duration && mp4.timescale ? mp4.duration / mp4.timescale : 0,
        };
        this.cfg = {
          codec: track.codec,
          description: codecDescription(file, track.id),
          codedWidth: track.video.width,
          codedHeight: track.video.height,
          hardwareAcceleration: 'prefer-hardware', // GPU decode block
          optimizeForLatency: false, // favour throughput + full reorder pipeline (smooth play > low latency)
        };
        // Collect every encoded sample (compressed → small), then we decode on demand.
        file.onSamples = (_id: number, _u: unknown, samples: MP4Sample[]) => {
          for (const s of samples) {
            const idx = this.samples.length;
            this.samples.push({ ts: (s.cts / s.timescale) * 1e6, dur: (s.duration / s.timescale) * 1e6, key: s.is_sync, data: s.data });
            if (s.is_sync) this.keyframes.push(idx);
          }
        };
        file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
        file.start();
        file.flush(); // drain remaining samples synchronously
        // NOTE: samples stay in DECODE order (as mp4box delivers them). A VideoDecoder must be fed in
        // decode order — sorting by presentation time would feed B-frames before their references and
        // produce corruption. We drive seeking/look-ahead by each sample's presentation time (`ts`)
        // WITHOUT reordering the feed. Keyframe presentation times ARE monotonic in decode order.
        done(this.samples.length ? this.info : null);
      };

      (buf as ArrayBuffer & { fileStart?: number }).fileStart = 0;
      file.appendBuffer(buf as ArrayBuffer & { fileStart: number });
      file.flush();
    });
  }

  getInfo(): Info | null { return this.info; }
  aspect(): number | null { return this.info && this.info.width > 0 ? this.info.width / this.info.height : null; }

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    if (!this.cfg) return null;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        // Insert keeping the buffer ordered by presentation timestamp.
        if (this.buffer.length && frame.timestamp < this.buffer[this.buffer.length - 1].timestamp) {
          let i = this.buffer.length;
          while (i > 0 && this.buffer[i - 1].timestamp > frame.timestamp) i--;
          this.buffer.splice(i, 0, frame);
        } else {
          this.buffer.push(frame);
        }
        this.evict();
      },
      error: (e) => { console.warn('[mp4] decode error', e.message); },
    });
    return this.decoder; // configured lazily in seekSegment (single reset+configure path)
  }

  // Retire decoded frames the playhead has passed (keeping KEEP_BEHIND) so the hardware decoder's output
  // surfaces free up promptly — the key to not stalling NVDEC at 4K. Buffer stays sorted ascending by ts.
  private evict(): void {
    // Frames with ts ≤ wantUs are a prefix; keep the most recent KEEP_BEHIND of them (incl. the present
    // frame) and close the rest.
    let firstAhead = 0;
    while (firstAhead < this.buffer.length && this.buffer[firstAhead].timestamp <= this.wantUs) firstAhead++;
    const removePast = Math.max(0, firstAhead - KEEP_BEHIND);
    for (let i = 0; i < removePast; i++) this.buffer[i].close();
    if (removePast) this.buffer.splice(0, removePast);
    // Safety cap (shouldn't trigger with paced feeding): drop furthest-future frames, they're re-decodable.
    while (this.buffer.length > MAX_BUFFER) this.buffer.pop()!.close();
  }

  // Decode-order index of the latest keyframe whose presentation time ≤ `us`. Keyframe (IDR) times are
  // monotonic in decode order, so a forward scan of the (small) keyframe list is correct.
  private keyframeForTime(us: number): number {
    let kf = this.keyframes.length ? this.keyframes[0] : 0;
    for (const k of this.keyframes) { if (this.samples[k].ts <= us) kf = k; else break; }
    return kf;
  }

  // Restart decoding from keyframe `kf`. Drops the buffered frames — they belong to the OLD segment, and
  // keeping them would poison the feed pacing: after a loop wrap (wantUs → 0) the stale end-of-clip frames
  // still read as "ahead" (ts > 0), so framesAhead would hit target and we'd never feed → freeze. We keep
  // ONLY the newest frame so the seam shows the last frame during the ~2-frame refill instead of black.
  private seekSegment(kf: number): void {
    const dec = this.ensureDecoder();
    if (!dec) return;
    try { dec.reset(); } catch { /* */ }
    try { dec.configure(this.cfg!); } catch (e) { console.warn('[mp4] configure failed', (e as Error).message); return; }
    if (this.buffer.length > 1) {
      const hold = this.buffer[this.buffer.length - 1]; // highest ts (sorted asc) = most recent
      for (let i = 0; i < this.buffer.length - 1; i++) this.buffer[i].close();
      this.buffer = [hold];
    }
    this.segStart = kf;
    this.fedTo = kf - 1;
  }

  // Feed the decoder (in DECODE order) so presentation times up to playhead + LOOKAHEAD are decoded.
  // Re-seeks only when needed: idle, backward jump, or the playhead has passed the fed edge and a nearer
  // keyframe lets us skip ahead. Forward playback across GOP boundaries needs NO reset (the decoder
  // consumes mid-stream keyframes as ordinary chunks).
  private pump(): void {
    if (!this.samples.length) return;
    const kf = this.keyframeForTime(this.wantUs);
    const fedTs = this.fedTo >= 0 ? this.samples[this.fedTo].ts : -Infinity;

    if (this.segStart === -1 || kf < this.segStart) {
      this.seekSegment(kf);               // idle, or backward jump (loop wrap / scrub) before this segment
    } else if (kf > this.segStart && fedTs < this.wantUs) {
      this.seekSegment(kf);               // fell behind the playhead and a nearer keyframe exists → skip
    }

    const dec = this.ensureDecoder();
    if (!dec) return;
    // Pace feeding to keep ~TARGET_AHEAD frames decoded-or-in-flight past the playhead — NOT a big time
    // window (that would hold too many 4K surfaces and stall NVDEC). framesAhead counts already-decoded
    // frames past the playhead; decodeQueueSize counts in-flight. Feed until their sum hits the target.
    let framesAhead = 0;
    for (const f of this.buffer) if (f.timestamp > this.wantUs) framesAhead++;
    while (
      this.fedTo + 1 < this.samples.length &&
      dec.decodeQueueSize < QUEUE_BUDGET &&
      framesAhead + dec.decodeQueueSize < TARGET_AHEAD
    ) {
      const next = this.samples[++this.fedTo];
      try { dec.decode(new EncodedVideoChunk({ type: next.key ? 'key' : 'delta', timestamp: next.ts, duration: next.dur, data: next.data })); }
      catch { /* skip a bad chunk */ }
    }
    this.evict();
  }

  // Return the decoded frame for (looped) `timeSec`, driving decode-ahead. Zero-copy VideoFrame.
  frame(timeSec: number): VideoFrame | null {
    if (!this.samples.length) return null;
    const dur = this.info?.durationSec || 0;
    const t = dur > 0 ? ((timeSec % dur) + dur) % dur : Math.max(0, timeSec);
    this.wantUs = t * 1e6;
    this.pump();

    // Prefer the latest decoded frame at/just-before the playhead (never show a future frame); if none is
    // ready yet (right after a seek), fall back to the earliest buffered frame so we show something.
    let best: VideoFrame | null = null;
    for (const f of this.buffer) {
      if (f.timestamp <= this.wantUs + 1000) { if (!best || f.timestamp > best.timestamp) best = f; }
    }
    if (!best) for (const f of this.buffer) { if (!best || f.timestamp < best.timestamp) best = f; }
    return best;
  }

  close(): void {
    for (const f of this.buffer) f.close();
    this.buffer = [];
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* */ }
    this.decoder = null; this.segStart = -1; this.fedTo = -1;
  }
}

// --- per-path registries -------------------------------------------------------------------------
// Surfaces + timeline layers share ONE playback decoder per file (one playhead per file). Thumbnails
// get SEPARATE decoders: a filmstrip scrubs to scattered times, and reusing the playback decoder would
// reseek it out from under a playing surface (the old cause of stutter). Isolation keeps play smooth.
const decoders = new Map<string, FileDecoder>();
const opening = new Map<string, Promise<Info | null>>();
const results = new Map<string, boolean>(); // probed: true = decodable MP4, false = not (fall back to <video>)

const thumbDecoders = new Map<string, FileDecoder>();
const thumbOpening = new Map<string, Promise<Info | null>>();

export function ensureOpen(path: string): Promise<Info | null> {
  const existing = opening.get(path);
  if (existing) return existing;
  if (decoders.has(path)) return Promise.resolve(decoders.get(path)!.getInfo());
  const d = new FileDecoder();
  const p = d.open(path).then((info) => {
    if (info) decoders.set(path, d); else d.close();
    results.set(path, info !== null);
    opening.delete(path);
    return info;
  });
  opening.set(path, p);
  return p;
}

export function probed(path: string): boolean | undefined { return results.get(path); }
export function frame(path: string, timeSec: number): VideoFrame | null { return decoders.get(path)?.frame(timeSec) ?? null; }
export function aspect(path: string): number | null { return decoders.get(path)?.aspect() ?? null; }
export function close(path: string): void { decoders.get(path)?.close(); decoders.delete(path); results.delete(path); }

// Dedicated thumbnail decoder (isolated from the playback decoder above).
export async function thumbnail(path: string, timeSec: number): Promise<VideoFrame | null> {
  let d = thumbDecoders.get(path);
  if (!d) {
    let p = thumbOpening.get(path);
    if (!p) {
      const nd = new FileDecoder();
      p = nd.open(path).then((info) => { if (info) thumbDecoders.set(path, nd); else nd.close(); thumbOpening.delete(path); return info; });
      thumbOpening.set(path, p);
    }
    await p;
    d = thumbDecoders.get(path);
    if (!d) return null;
  }
  return d.frame(timeSec);
}
