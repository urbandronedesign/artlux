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
//  • Decode is DECOUPLED from presentation. `frame()` records the wanted playhead time and picks the
//    nearest already-decoded frame — it never blocks. A paced pump keeps a SMALL window of frames
//    decoded ahead (a HW decoder's output-surface pool is tiny — holding many 4K frames stalls NVDEC).
//  • SEAMLESS LOOP: we work in an ABSOLUTE sample index / absolute timestamp space. For a looping
//    surface the wanted time is the free-running (monotonic) clock, so the feed just keeps going — at
//    the wrap boundary the next fed sample is sample 0 (a keyframe) with its timestamp offset by
//    +duration, which the decoder consumes as a fresh GOP mid-stream with NO reset and NO buffer drop.
//    That removes the loop-point hitch entirely. We only reset the decoder on a BACKWARD jump
//    (timeline scrub) — never during forward looped playback.
//  • Samples are fed in DECODE order (as mp4box delivers them). A VideoDecoder MUST be fed in decode
//    order — sorting by presentation time feeds B-frames before their references → corruption. We drive
//    seeking off presentation time (`ts`, monotonic for keyframes) WITHOUT reordering the feed.
//  • `frame()` returns the `VideoFrame` DIRECTLY — a VideoFrame is a `CanvasImageSource`, so the GPU
//    compositor uploads it straight to a texture (zero CPU copy).
//
// WebCodecs is a Chromium renderer API (present in the Electron renderer). If it or the codec is
// unavailable, open() resolves null and the host falls back to a plain <video> element.

const TARGET_AHEAD = 5;  // decoded (or in-flight) frames to keep ahead — must exceed the B-frame reorder
                         // depth (≤4 for H.264) or the decoder never emits its first frame (startup stall)
const KEEP_BEHIND = 1;   // decoded past frames to retain (present frame + async-consumer slack)
const MAX_BUFFER = 12;   // safety cap on live VideoFrames (paced feeding keeps us well under this)
const QUEUE_BUDGET = 8;  // in-flight chunk cap — ≥ TARGET_AHEAD so we can actually reach the target depth
const EPS_US = 8_000;    // ~½ a 60fps frame — playhead-jitter tolerance for backward-jump detection

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
  private buffer: VideoFrame[] = []; // decoded frames (GPU), sorted by ABSOLUTE presentation timestamp
  private info: Info | null = null;
  private durUs = 0;       // clip duration in µs (loop period)
  // Absolute space: an "abs" index can exceed samples.length; loop L, local i → abs = L*N + i, and its
  // timestamp is samples[i].ts + L*durUs. This makes a looping feed a plain monotonically-advancing feed.
  private segAbs = -1;     // absolute keyframe index the decoder was last (re)started from (-1 = idle)
  private fedAbs = -1;     // last absolute index fed to the decoder since the last seek
  private wantUs = 0;      // latest requested ABSOLUTE presentation time (µs)
  private lastWantUs = -Infinity; // previous frame()'s wantUs — detects a backward jump (timeline loop / scrub)

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
        this.durUs = this.info.durationSec * 1e6;
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
        if (!this.samples.length) return done(null);

        // ASK THE DECODER BEFORE CLAIMING THE FILE.
        //
        // Everything above only proves mp4box can DEMUX the container. Whether WebCodecs can actually
        // decode this track is a different question — an HEVC profile, a 10-bit pixel format or an
        // exotic level can demux perfectly and then fail at configure(). That failure surfaces far away
        // (seekSegment logs a warning and returns), by which point the host has already handed this
        // file to the codec and torn down the <video> that would have played it: the surface just goes
        // black, silently, and the app claims to be playing something it is not.
        //
        // Declining here instead makes the existing fallbacks do their job — a false probe sends
        // surfaces back to a <video> element (contentSource), timeline layers to syncVideoLayer, and
        // thumbnails to the video queue. This became load-bearing when WebCodecs stopped being opt-in.
        void VideoDecoder.isConfigSupported(this.cfg!)
          .then((s) => {
            if (!s.supported) console.info('[mp4] declining', path, '— WebCodecs cannot configure', this.cfg!.codec);
            done(s.supported ? this.info : null);
          })
          .catch(() => done(null)); // a malformed config throws rather than resolving unsupported
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
        // Insert keeping the buffer ordered by (absolute) presentation timestamp.
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

  // --- absolute-index helpers (N = sample count; loop L, local i ↔ abs = L*N + i) -----------------
  private sampleOfAbs(abs: number): Enc { const N = this.samples.length; return this.samples[((abs % N) + N) % N]; }
  private tsOfAbs(abs: number): number { const N = this.samples.length; return this.sampleOfAbs(abs).ts + Math.floor(abs / N) * this.durUs; }

  // Retire decoded frames the playhead has passed (keeping KEEP_BEHIND) so the hardware decoder's output
  // surfaces free up promptly — the key to not stalling NVDEC at 4K. Buffer stays sorted ascending by ts.
  private evict(): void {
    let firstAhead = 0;
    while (firstAhead < this.buffer.length && this.buffer[firstAhead].timestamp <= this.wantUs) firstAhead++;
    const removePast = Math.max(0, firstAhead - KEEP_BEHIND);
    for (let i = 0; i < removePast; i++) this.buffer[i].close();
    if (removePast) this.buffer.splice(0, removePast);
    // Safety cap (shouldn't trigger with paced feeding): drop furthest-future frames, they're re-decodable.
    while (this.buffer.length > MAX_BUFFER) this.buffer.pop()!.close();
  }

  // Local decode-order index of the latest keyframe whose presentation time ≤ `localUs`. Keyframe (IDR)
  // times are monotonic in decode order, so a forward scan of the (small) keyframe list is correct.
  private localKeyframeForTime(localUs: number): number {
    let kf = this.keyframes.length ? this.keyframes[0] : 0;
    for (const k of this.keyframes) { if (this.samples[k].ts <= localUs) kf = k; else break; }
    return kf;
  }

  // Restart decoding from absolute keyframe `absKf` (backward scrub only). Drops the buffered frames — they
  // belong to the OLD position and would poison the feed pacing — but keeps the single newest so the seam
  // shows a frame during the ~2-frame refill instead of black. NOT called during forward looped playback.
  private seekSegment(absKf: number): void {
    const dec = this.ensureDecoder();
    if (!dec) return;
    try { dec.reset(); } catch { /* */ }
    try { dec.configure(this.cfg!); } catch (e) { console.warn('[mp4] configure failed', (e as Error).message); return; }
    if (this.buffer.length > 1) {
      const hold = this.buffer[this.buffer.length - 1]; // highest ts (sorted asc) = most recent
      for (let i = 0; i < this.buffer.length - 1; i++) this.buffer[i].close();
      this.buffer = [hold];
    }
    this.segAbs = absKf;
    this.fedAbs = absKf - 1;
  }

  // Feed the decoder (in DECODE order, across the loop boundary when `loop`) to keep ~TARGET_AHEAD frames
  // decoded-or-in-flight past the playhead. Re-seeks ONLY on a backward jump (scrub) or a big forward jump.
  private pump(loop: boolean, loopCount: number, localUs: number): void {
    const N = this.samples.length;
    if (!N) return;
    const localKf = this.localKeyframeForTime(localUs);
    const kfAbs = loopCount * N + localKf;
    const fedTs = this.fedAbs >= 0 ? this.tsOfAbs(this.fedAbs) : -Infinity;
    // Is there a frame we can actually present at/just-before the playhead right now?
    const havePresentable = this.buffer.some((f) => f.timestamp <= this.wantUs + EPS_US);
    // Did the playhead jump BACKWARD since last frame()? (timeline loop-back / scrub-back). NOT the
    // seamless surface loop, whose wantUs is absolute-monotonic — that never trips this.
    const wentBackward = this.wantUs < this.lastWantUs - EPS_US;

    if (this.segAbs === -1 || kfAbs < this.segAbs) {
      this.seekSegment(kfAbs);              // idle, or backward jump before the current segment's anchor
    } else if (kfAbs > this.segAbs && fedTs < this.wantUs) {
      this.seekSegment(kfAbs);              // fell behind the playhead and a nearer keyframe exists → skip
    } else if (wentBackward && !havePresentable) {
      // Backward jump WITHIN the same anchor GOP (e.g. a non-looping timeline layer whose segAbs stayed at
      // keyframe 0 for the whole clip): kfAbs === segAbs so the checks above miss it, yet we've already fed
      // past the target and hold only stale forward frames → must re-seek or the layer freezes after the
      // first pass. (Guarded by !havePresentable so a tiny scrub-back that's still buffered doesn't reset,
      // and by wentBackward so forward playback/startup — monotonic wantUs — never trips it.)
      this.seekSegment(kfAbs);
    }
    // NOTE: at a seamless surface LOOP wrap, kfAbs advances to (loopCount+1)*N but wantUs is absolute-
    // monotonic (never backward) and fedTs is already ≥ wantUs, so NO branch fires — the feed simply
    // continues into sample 0 of the next loop (a keyframe), giving a reset-free, seamless loop.

    const dec = this.ensureDecoder();
    if (!dec) return;
    const maxAbs = loop ? Infinity : N - 1; // don't loop-feed a timeline layer / thumbnail
    let framesAhead = 0;
    for (const f of this.buffer) if (f.timestamp > this.wantUs) framesAhead++;
    while (this.fedAbs < maxAbs && dec.decodeQueueSize < QUEUE_BUDGET && framesAhead + dec.decodeQueueSize < TARGET_AHEAD) {
      this.fedAbs++;
      const s = this.sampleOfAbs(this.fedAbs);
      const ts = this.tsOfAbs(this.fedAbs);
      try { dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: ts, duration: s.dur, data: s.data })); }
      catch { /* skip a bad chunk */ }
    }
    this.evict();
  }

  // Return the decoded frame for `timeSec`. `loop` (surfaces): timeSec is the monotonic wall clock and the
  // decoder loops seamlessly. `!loop` (timeline layer / thumbnail): timeSec is clip-local, clamped, seekable.
  frame(timeSec: number, loop = true): VideoFrame | null {
    const N = this.samples.length;
    if (!N) return null;
    const timeUs = timeSec * 1e6;
    let loopCount: number, localUs: number;
    if (loop && this.durUs > 0) {
      const abs = Math.max(0, timeUs);
      loopCount = Math.floor(abs / this.durUs);
      localUs = abs - loopCount * this.durUs;
      this.wantUs = abs;
    } else {
      loopCount = 0;
      localUs = this.durUs > 0 ? Math.min(Math.max(0, timeUs), this.durUs) : Math.max(0, timeUs);
      this.wantUs = localUs;
    }
    this.pump(loop && this.durUs > 0, loopCount, localUs);
    this.lastWantUs = this.wantUs; // for next call's backward-jump detection

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
    this.decoder = null; this.segAbs = -1; this.fedAbs = -1; this.lastWantUs = -Infinity;
  }
}

// --- decoder registries --------------------------------------------------------------------------
// Three isolated pools, because their playheads move independently and one decoder = one playhead:
//  • per-PATH  — the playing surface (looping, monotonic clock).
//  • per-LAYER — a timeline clip (keyed by layerId): frame-exact scrub, isolated so a scrub never reseeks
//    the surface's decoder (that contention was a stutter source), and each layer scrubs independently.
//  • per-PATH thumbnails — a filmstrip scrubs to scattered times; isolated from the playing surface.
const decoders = new Map<string, FileDecoder>();
const opening = new Map<string, Promise<Info | null>>();
const results = new Map<string, boolean>(); // probed: true = decodable MP4, false = not (fall back to <video>)

const layerDecoders = new Map<string, { dec: FileDecoder; path: string }>(); // key = layerId
const layerOpening = new Map<string, Promise<Info | null>>();

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
export function frame(path: string, timeSec: number): VideoFrame | null { return decoders.get(path)?.frame(timeSec, true) ?? null; }
export function aspect(path: string): number | null { return decoders.get(path)?.aspect() ?? null; }
export function close(path: string): void { decoders.get(path)?.close(); decoders.delete(path); results.delete(path); }

// Timeline layer: a dedicated, non-looping (seekable) decoder per layerId. Lazily opened; returns null
// until ready. `clipTimeSec` is clip-local (already includes in-point) — a scrub seeks frame-exactly.
export function layerFrame(layerId: string, path: string, clipTimeSec: number): VideoFrame | null {
  const cur = layerDecoders.get(layerId);
  if (cur && cur.path === path) return cur.dec.frame(clipTimeSec, false);
  if (cur) { cur.dec.close(); layerDecoders.delete(layerId); } // clip on this layer changed file
  if (!layerOpening.has(layerId)) {
    const nd = new FileDecoder();
    const p = nd.open(path).then((info) => { if (info) layerDecoders.set(layerId, { dec: nd, path }); else nd.close(); layerOpening.delete(layerId); return info; });
    layerOpening.set(layerId, p);
  }
  return null; // opening
}

export function releaseLayer(layerId: string): void {
  const cur = layerDecoders.get(layerId);
  if (cur) cur.dec.close();
  layerDecoders.delete(layerId);
}

// Dedicated thumbnail decoder (isolated from the playback decoder above), seekable (non-looping).
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
  return d.frame(timeSec, false);
}
