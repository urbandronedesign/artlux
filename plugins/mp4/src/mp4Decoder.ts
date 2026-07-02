import MP4Box, { type MP4File, type MP4Info, type MP4Sample, type MP4VideoTrack } from 'mp4box';
import { resolveMediaUrl } from '@/services/mediaCache'; // host: absolute path → blob: URL (transitional seam)

// High-performance, GPU-accelerated MP4 (H.264/H.265) decode via WebCodecs.
//
// Design (why it's fast + light):
//  • mp4box demuxes the container ONCE into encoded samples (H.264 NAL units) — those are tiny
//    (compressed), so keeping the whole track's samples in RAM is cheap; we never eager-decode.
//  • `VideoDecoder` runs with `hardwareAcceleration: 'prefer-hardware'`, so decode uses the GPU's
//    fixed-function video block (NVDEC/…) — no CPU decode, no H.264 hardware-*session* cap the way a
//    <video> element has, so many surfaces/layers can run at once.
//  • We decode ON DEMAND around the playhead (a small look-ahead window) starting from the nearest
//    prior keyframe, and keep only a bounded buffer of decoded `VideoFrame`s (GPU textures), LRU-
//    closed. Memory stays flat regardless of clip length.
//  • `frame()` returns the `VideoFrame` DIRECTLY — a VideoFrame is a `CanvasImageSource`, so the
//    WebGPU/WebGL compositor uploads it straight to a texture (zero CPU copy, no intermediate 2D
//    canvas). Returned frames stay alive in the buffer (~BUFFER frames) before eviction, covering
//    async consumers (NDI capture / projector streaming) that read the drawable after the tick.
//
// WebCodecs is a Chromium renderer API (present in the Electron renderer). If it or the codec is
// unavailable, open() resolves null and the host falls back to a plain <video> element.

const BUFFER = 16;          // decoded VideoFrames kept live (GPU) — also the async-consumer keep-alive
const LOOKAHEAD_US = 250_000; // decode this far ahead of the playhead (µs)
const QUEUE_BUDGET = 8;     // cap the decoder's in-flight queue (backpressure)

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
  private samples: Enc[] = [];   // ALL encoded samples (decode order) — cheap; decoded on demand
  private keyframes: number[] = []; // indices in samples[] that are keyframes
  private buffer: VideoFrame[] = []; // decoded frames (GPU), bounded; sorted-ish by timestamp
  private info: Info | null = null;
  private segStart = -1;   // keyframe sample index the decoder is currently decoding from (-1 = idle)
  private fedTo = -1;      // last sample index fed to the decoder in this segment

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
          optimizeForLatency: true,
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
        // Frames may arrive out of decode order for B-frames → keep the buffer ordered by timestamp.
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
        // Insert keeping the buffer ordered by presentation timestamp; evict the oldest past BUFFER.
        this.buffer.push(frame);
        if (this.buffer.length > 1 && frame.timestamp < this.buffer[this.buffer.length - 2].timestamp) {
          this.buffer.sort((a, b) => a.timestamp - b.timestamp);
        }
        while (this.buffer.length > BUFFER) this.buffer.shift()?.close();
      },
      error: () => { /* transient — a reset on the next seek recovers */ },
    });
    try { this.decoder.configure(this.cfg); } catch { this.decoder = null; }
    return this.decoder;
  }

  // Nearest keyframe sample index at or before `sampleIdx`.
  private keyframeAtOrBefore(sampleIdx: number): number {
    let kf = 0;
    for (const k of this.keyframes) { if (k <= sampleIdx) kf = k; else break; }
    return kf;
  }

  // Restart decoding from keyframe `kf` (drops in-flight state + buffered frames).
  private seekSegment(kf: number): void {
    const dec = this.ensureDecoder();
    if (!dec) return;
    try { dec.reset(); dec.configure(this.cfg!); } catch { /* */ }
    for (const f of this.buffer) f.close();
    this.buffer = [];
    this.segStart = kf;
    this.fedTo = kf - 1;
  }

  // Return the decoded frame for (looped) `timeSec`, driving decode-ahead. Zero-copy VideoFrame.
  frame(timeSec: number): VideoFrame | null {
    if (!this.samples.length) return null;
    const dur = this.info?.durationSec || 0;
    const t = dur > 0 ? ((timeSec % dur) + dur) % dur : Math.max(0, timeSec);
    const targetUs = t * 1e6;

    // Target sample index (largest sample whose presentation time ≤ target).
    let targetIdx = 0;
    for (let i = 0; i < this.samples.length; i++) { if (this.samples[i].ts <= targetUs) targetIdx = i; else break; }

    // Seek if we're not decoding a segment that covers the target, or the playhead jumped backward
    // (loop wrap / scrub) before the current segment start.
    const kf = this.keyframeAtOrBefore(targetIdx);
    if (this.segStart === -1 || kf < this.segStart || targetIdx < this.fedTo - this.samples.length) {
      this.seekSegment(kf);
    } else if (targetIdx < this.segStart) {
      this.seekSegment(kf);
    }

    // Feed forward up to target + look-ahead, bounded by the decoder's in-flight budget.
    const dec = this.ensureDecoder();
    if (dec) {
      const lookaheadUs = targetUs + LOOKAHEAD_US;
      while (this.fedTo + 1 < this.samples.length && dec.decodeQueueSize < QUEUE_BUDGET) {
        const next = this.samples[this.fedTo + 1];
        if (this.fedTo + 1 > targetIdx && next.ts > lookaheadUs) break; // enough ahead
        this.fedTo++;
        try { dec.decode(new EncodedVideoChunk({ type: next.key ? 'key' : 'delta', timestamp: next.ts, duration: next.dur, data: next.data })); }
        catch { /* skip */ }
      }
    }

    // Pick the buffered frame nearest the target (frames just behind the playhead are ideal).
    let best: VideoFrame | null = null, bd = Infinity;
    for (const f of this.buffer) { const d = Math.abs(f.timestamp - targetUs); if (d < bd) { bd = d; best = f; } }
    return best;
  }

  close(): void {
    for (const f of this.buffer) f.close();
    this.buffer = [];
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* */ }
    this.decoder = null; this.segStart = -1; this.fedTo = -1;
  }
}

// --- per-path registry (surfaces + timeline layers share one decoder per file) ---
const decoders = new Map<string, FileDecoder>();
const opening = new Map<string, Promise<Info | null>>();
const results = new Map<string, boolean>(); // probed: true = decodable MP4, false = not (fall back to <video>)

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
