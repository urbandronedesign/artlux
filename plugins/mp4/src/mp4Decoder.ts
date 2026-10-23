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
// The tolerance on "which decoded frame is ON SCREEN at time t". Shared by frame() and
// frameExact() ON PURPOSE: an offline render must pick the SAME frame live playback would at the
// same instant, or the two disagree at clip boundaries and a bake cannot be diffed against the
// live output to prove it correct. One constant, so they cannot drift apart.
const PRESENT_EPS_US = 1_000;
// Infinite-loop guard for the offline feed. Each round nets ~TARGET_AHEAD frames, so this covers a
// GOP far longer than any encoder produces; it exists so a malformed file cannot hang a render.
const EXACT_MAX_ROUNDS = 2_000;

interface Info { width: number; height: number; durationSec: number; }
// One encoded sample, decode order, µs timestamps. `off`/`size` locate it in the FILE; `data` is set only
// for a store parsed whole (a fragmented file — see loadStore). A ranged store keeps bytes per GOP instead.
interface Enc { ts: number; dur: number; key: boolean; off: number; size: number; data?: Uint8Array }
// What __artluxMp4Fault can do to a live decoder — see the measurement section at the end of the file.
type Mp4FaultKind = 'close' | 'error' | 'configure';

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

// The decoder config for a parsed track. ONE builder, shared by FileDecoder.open() and the index-only
// probe, because the probe's isConfigSupported() verdict is only worth something if it judged the very
// config the decoder will later configure() with.
function trackConfig(file: MP4File, track: MP4VideoTrack): VideoDecoderConfig {
  return {
    codec: track.codec,
    description: codecDescription(file, track.id),
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    hardwareAcceleration: 'prefer-hardware', // GPU decode block
    optimizeForLatency: false, // favour throughput + full reorder pipeline (smooth play > low latency)
  };
}

// ── ONE COPY OF A FILE, HOWEVER MANY DECODERS READ IT ───────────────────────────────────────────────
// A file's demuxed track — its config and every encoded sample — is immutable once parsed, and the
// three pools (surface, layer, thumbnail) each kept their OWN copy of it: measured 2026-10-23, 4,062 MB
// resident for a 1,355 MB clip on a surface and a timeline layer, exactly 3×. What genuinely differs
// per decoder is the PLAYHEAD (the VideoDecoder, its buffer, segAbs/fedAbs), so that stays in
// FileDecoder and the samples move here, refcounted: the store is parsed once, shared by every holder,
// and dropped with the last one. A second open of a file already held is instant — no read, no demux.
//
// Holders are FileDecoders (one hold each, for their life) and the timeline's pre-warm (`prewarm()`,
// one hold per path, released by close(path) when the residency owners let go).
//
// ── AND THE STORE DOES NOT HOLD THE FILE (plans/mp4-memory-residency.md step 3) ──────────────────────
// Holding the parse once still held the WHOLE track: 1,291 MB for a 142 s 5.7K clip, growing with file
// length, plus a ~4 s read + demux on the renderer main thread before the first frame. A decoder only
// ever needs the samples just ahead of its own playhead, and H.264/H.265 can only start at a keyframe —
// so the unit of residency is the GOP. A RANGED store keeps the sample TABLE (offset/size/time/keyframe
// for every frame, read from the moov by byte range, ~tens of bytes a frame) and reads each GOP's bytes
// by one Range request when a decoder is about to feed it, into a cache with a byte budget.
//
//   · want()   — every pump() names the GOP it is feeding and GOP_AHEAD after it (wrapping for a looping
//                surface). Missing ones are read; present ones are marked used. That is the read-ahead.
//   · dataOf() — the bytes of one sample if its GOP is resident, else null: pump() stops feeding there
//                (the picture holds) and resumes when the read lands — usually long before it is needed.
//   · GOP 0 is pinned: it is where a cold open, a looping surface's wrap and a timeline loop all land.
//   · evict()  — over budget, drop the least-recently-used GOPs that no decoder has touched for
//                GOP_PROTECT_MS. Several playheads on one file share one cache, which is the point.
//
// A fragmented file keeps its sample table in moof boxes spread through the file, so the moov alone
// cannot index it: it is parsed WHOLE as before (`ranged === false`, `data` on every sample).
const GOP_CACHE_BUDGET = 256 * 1024 * 1024; // per store; raised to 4 GOPs for a file whose GOPs are huge
const GOP_AHEAD = 2;                         // GOPs read ahead of the one being fed
const GOP_PROTECT_MS = 1000;                 // a GOP used this recently is in someone's window
const GOP_RETRY_MS = 1000;                   // a failed read is retried after this long, not every frame

interface Gop { buf: Uint8Array | null; base: number; lastUsed: number; loading: Promise<void> | null; failedAt: number }

class SampleStore {
  holders = 0;
  private readonly gops = new Map<number, Gop>();
  private cacheBytes = 0;
  private maxGopBytes = 0;
  private readFailures = 0;
  reads = 0;      // GOP reads issued — diagnostics
  readMs = 0;     // total time they took

  constructor(
    readonly path: string,
    private readonly url: string,
    readonly info: Info,
    readonly cfg: VideoDecoderConfig,
    readonly samples: readonly Enc[],      // ALL samples in DECODE order (bytes only if !ranged)
    readonly keyframes: readonly number[], // decode-order indices that are keyframes (ascending)
    readonly ranged: boolean,
    private readonly wholeBytes: number,   // !ranged: Σ sample bytes, all resident
  ) {
    if (ranged) for (let g = 0; g < this.gopCount; g++) { const [a, b] = this.byteRange(g); this.maxGopBytes = Math.max(this.maxGopBytes, b - a); }
  }

  /** Bytes this store holds right now — counted ONCE in residentBytes, whoever holds it. */
  get bytes(): number { return this.ranged ? this.cacheBytes : this.wholeBytes; }
  get gopCount(): number { return Math.max(1, this.keyframes.length); }
  get residentGops(): number { let n = 0; for (const e of this.gops.values()) if (e.buf) n++; return n; }

  /** The GOP holding decode-order sample `i` (samples before the first keyframe belong to GOP 0). */
  gopOf(i: number): number {
    const k = this.keyframes;
    let lo = 0, hi = k.length - 1, g = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (k[m] <= i) { g = m; lo = m + 1; } else hi = m - 1; }
    return g;
  }

  // [first, last+1) file bytes of a GOP's samples. Usually contiguous; with an interleaved audio track
  // the span also covers the audio between them, which is cheaper to over-read than to split.
  private byteRange(g: number): [number, number] {
    const start = g === 0 ? 0 : this.keyframes[g];
    const end = g + 1 < this.keyframes.length ? this.keyframes[g + 1] : this.samples.length;
    let a = Infinity, b = 0;
    for (let i = start; i < end; i++) { const s = this.samples[i]; if (s.off < a) a = s.off; if (s.off + s.size > b) b = s.off + s.size; }
    return a === Infinity ? [0, 0] : [a, b];
  }

  /** Sample `i`'s bytes, or null if its GOP is not resident yet. */
  dataOf(i: number): Uint8Array | null {
    const s = this.samples[i];
    if (s.data) return s.data;
    const e = this.gops.get(this.gopOf(i));
    if (!e?.buf) return null;
    e.lastUsed = performance.now();
    return e.buf.subarray(s.off - e.base, s.off - e.base + s.size);
  }

  /** Make GOP `g` resident. null = already resident; otherwise a promise that settles when it is (or failed). */
  request(g: number): Promise<void> | null {
    if (!this.ranged) return null;
    const now = performance.now();
    let e = this.gops.get(g);
    if (e?.buf) { e.lastUsed = now; return null; }
    if (e?.loading) return e.loading;
    if (e && now - e.failedAt < GOP_RETRY_MS) {
      const wait = GOP_RETRY_MS - (now - e.failedAt);
      return new Promise<void>((r) => { setTimeout(r, wait); });
    }
    const [a, b] = this.byteRange(g);
    if (b <= a) return null;
    if (!e) { e = { buf: null, base: a, lastUsed: now, loading: null, failedAt: 0 }; this.gops.set(g, e); }
    const entry = e;
    this.reads++;
    entry.loading = (async () => {
      const t0 = performance.now();
      try {
        const res = await fetch(this.url, { headers: { Range: `bytes=${a}-${b - 1}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength !== b - a) throw new Error(`short read ${buf.byteLength}/${b - a}`);
        if (this.gops.get(g) !== entry) return; // the store was dropped while this was in flight
        entry.buf = buf;
        entry.lastUsed = performance.now();
        this.cacheBytes += buf.byteLength;
        this.evict();
      } catch (err) {
        entry.failedAt = performance.now();
        // A file that vanished mid-show fails every read; say so a few times, not every second forever.
        if (++this.readFailures <= 3) console.warn('[mp4] GOP read failed', this.path, `gop ${g}`, (err as Error).message);
      } finally {
        this.readMs += performance.now() - t0;
        entry.loading = null;
      }
    })();
    return entry.loading;
  }

  /** The window a decoder is about to feed: the GOP holding sample `i` and GOP_AHEAD after it. */
  want(i: number, loop: boolean): void {
    if (!this.ranged) return;
    const g0 = this.gopOf(i);
    const now = performance.now();
    for (let k = 0; k <= GOP_AHEAD; k++) {
      let g = g0 + k;
      if (g >= this.gopCount) { if (!loop) break; g -= this.gopCount; }
      const e = this.gops.get(g);
      if (e?.buf) e.lastUsed = now; else void this.request(g);
    }
  }

  private evict(): void {
    const budget = Math.max(GOP_CACHE_BUDGET, 4 * this.maxGopBytes);
    if (this.cacheBytes <= budget) return;
    const now = performance.now();
    const victims = [...this.gops.entries()]
      .filter(([g, e]) => e.buf && g !== 0 && now - e.lastUsed > GOP_PROTECT_MS) // GOP 0 is pinned
      .sort((x, y) => x[1].lastUsed - y[1].lastUsed);
    for (const [g, e] of victims) {
      if (this.cacheBytes <= budget) break;
      this.cacheBytes -= e.buf!.byteLength;
      this.gops.delete(g);
    }
  }

  /** The last holder let go. In-flight reads see their entry gone and discard what they fetched. */
  drop(): void { this.gops.clear(); this.cacheBytes = 0; }
}

const stores = new Map<string, SampleStore>();
const storeLoading = new Map<string, Promise<SampleStore | null>>();

async function acquireStore(path: string): Promise<SampleStore | null> {
  let st = stores.get(path);
  if (!st) {
    let p = storeLoading.get(path);
    if (!p) {
      p = loadStore(path).finally(() => { storeLoading.delete(path); });
      storeLoading.set(path, p);
    }
    const loaded = await p;
    if (!loaded) return null;
    // Between the load resolving and this continuation, an earlier holder may have taken it and let it
    // go (holders → 0 → dropped from the map). It is still a valid parse; put it back rather than parse again.
    st = stores.get(path) ?? loaded;
    if (!stores.has(path)) stores.set(path, st);
  }
  st.holders++;
  return st;
}

function releaseStore(st: SampleStore): void {
  if (--st.holders > 0) return;
  // Only drop the map entry if it is THIS store — a later acquire may already have re-inserted a
  // successor for the same path (see acquireStore), and deleting that would orphan its holders' bytes.
  if (stores.get(st.path) === st) { stores.delete(st.path); st.drop(); }
}

// RANGED first: read the moov by byte range and build the sample table from it — no sample bytes are
// read here at all (they come per GOP, on demand). Falls back to the whole-file parse only for a file the
// index cannot describe: a fragmented one (its samples are in moofs), or one whose moov the ranged read
// could not find.
async function loadStore(path: string): Promise<SampleStore | null> {
  if (typeof VideoDecoder === 'undefined') return null; // WebCodecs unavailable
  const url = resolveMediaUrl(path);
  if (!url) return null;
  const ix = await readIndex(url);
  if (ix === 'missing') return null; // refused / missing — the whole-file read would fail the same way
  if (ix && !ix.mp4.isFragmented) {
    const table = ix.file.getTrackSamplesInfo(ix.track.id) ?? [];
    const samples: Enc[] = [];
    const keyframes: number[] = [];
    for (const s of table) {
      if (s.is_sync) keyframes.push(samples.length);
      samples.push({ ts: (s.cts / s.timescale) * 1e6, dur: (s.duration / s.timescale) * 1e6, key: s.is_sync, off: s.offset, size: s.size });
    }
    if (samples.length) {
      const cfg = trackConfig(ix.file, ix.track);
      // The same question the whole-file path asks before claiming a file (see there), on the same config.
      try {
        const sup = await VideoDecoder.isConfigSupported(cfg);
        if (!sup.supported) { console.info('[mp4] declining', path, '— WebCodecs cannot configure', cfg.codec); return null; }
      } catch { return null; }
      const durationSec = ix.mp4.duration && ix.mp4.timescale ? ix.mp4.duration / ix.mp4.timescale : 0;
      return new SampleStore(path, url, { width: ix.track.video.width, height: ix.track.video.height, durationSec },
        cfg, samples, keyframes, true, 0);
    }
  }
  return loadWholeStore(path, url);
}

// The whole-file parse — what every open did before step 3, kept for files the index cannot describe.
async function loadWholeStore(path: string, url: string): Promise<SampleStore | null> {
  // The FALLBACK only, since step 3: loadStore reads a normal file by GOP. This reads the whole file into
  // one buffer and keeps every sample — once, never twice (it used to fetch out of a Blob main had
  // already read over IPC, so a 300 MB clip cost 600 MB before a frame was decoded).
  // ⚠ A REFUSED OR MISSING FILE MUST FAIL HERE, NOT HANG. This did not check `ok`: a 404/403 is a
  // resolved fetch with an EMPTY body, and mp4box ignores an empty buffer without calling onReady or
  // onError — so the promise below never settled. Measured 2026-10-23: one thumbnail request for a
  // missing .mp4 held the thumbnail pump's `codecBusy` forever, and every later MP4 thumbnail in the
  // session queued behind it (a valid clip whose decoder was already open waited > 60 s and never ran).
  let buf: ArrayBuffer;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    buf = await res.arrayBuffer();
  } catch { return null; }
  if (!buf.byteLength) return null;

  return await new Promise<SampleStore | null>((resolve) => {
    const file: MP4File = MP4Box.createFile();
    let settled = false;
    let readied = false;
    const done = (v: SampleStore | null) => { if (!settled) { settled = true; resolve(v); } };
    file.onError = () => done(null);

    file.onReady = (mp4: MP4Info) => {
      readied = true;
      const track: MP4VideoTrack | undefined = mp4.videoTracks?.[0];
      if (!track) return done(null);
      const info: Info = {
        width: track.video.width, height: track.video.height,
        durationSec: mp4.duration && mp4.timescale ? mp4.duration / mp4.timescale : 0,
      };
      const cfg = trackConfig(file, track);
      const samples: Enc[] = [];
      const keyframes: number[] = [];
      let bytes = 0;
      // Collect every encoded sample (compressed), then decode on demand.
      file.onSamples = (_id: number, _u: unknown, got: MP4Sample[]) => {
        for (const s of got) {
          const idx = samples.length;
          samples.push({ ts: (s.cts / s.timescale) * 1e6, dur: (s.duration / s.timescale) * 1e6, key: s.is_sync, off: 0, size: s.data?.byteLength ?? 0, data: s.data });
          bytes += s.data?.byteLength ?? 0;
          if (s.is_sync) keyframes.push(idx);
        }
      };
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
      file.flush(); // drain remaining samples synchronously
      if (!samples.length) return done(null);
      const store = new SampleStore(path, url, info, cfg, samples, keyframes, false, bytes);

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
      void VideoDecoder.isConfigSupported(cfg)
        .then((s) => {
          if (!s.supported) console.info('[mp4] declining', path, '— WebCodecs cannot configure', cfg.codec);
          done(s.supported ? store : null);
        })
        .catch(() => done(null)); // a malformed config throws rather than resolving unsupported
    };

    (buf as ArrayBuffer & { fileStart?: number }).fileStart = 0;
    file.appendBuffer(buf as ArrayBuffer & { fileStart: number });
    file.flush();
    // The whole file has been parsed synchronously. No `moov` in it (a truncated download, a file that
    // is not MP4 at all) means onReady never fires and onError need not either — the same hang as above.
    if (!readied) done(null);
  });
}

class FileDecoder {
  private decoder: VideoDecoder | null = null;
  private cfg: VideoDecoderConfig | null = null;
  private store: SampleStore | null = null; // the shared parse this decoder holds (one hold, for its life)
  private samples: readonly Enc[] = [];      // = store.samples — ALL encoded samples in DECODE order
  private keyframes: readonly number[] = []; // = store.keyframes — decode-order keyframe indices (ascending)
  private buffer: VideoFrame[] = []; // decoded frames (GPU), sorted by ABSOLUTE presentation timestamp
  private info: Info | null = null;
  private durUs = 0;       // clip duration in µs (loop period)
  // Absolute space: an "abs" index can exceed samples.length; loop L, local i → abs = L*N + i, and its
  // timestamp is samples[i].ts + L*durUs. This makes a looping feed a plain monotonically-advancing feed.
  private segAbs = -1;     // absolute keyframe index the decoder was last (re)started from (-1 = idle)
  private fedAbs = -1;     // last absolute index fed to the decoder since the last seek
  private wantUs = 0;      // latest requested ABSOLUTE presentation time (µs)
  private lastWantUs = -Infinity; // previous frame()'s wantUs — detects a backward jump (timeline loop / scrub)
  lastFrameTs: number | null = null; // ABSOLUTE ts of the frame frame() last handed out — the generation
  private sortedCts: number[] | null = null; // presentation times, ascending — built on first frameExact()
  // Failure bookkeeping, read by __artluxMp4Stats — and, since the freeze fix, the recovery state.
  // See markDead() and plans/mp4-decoder-freeze.md.
  errors = 0;
  lastError: string | null = null;
  recoveries = 0;
  feedCapHits = 0;                   // times the per-call feed bound stopped pump() — 0 in healthy play
  private failNextConfigure = false; // armed by __artluxMp4Fault('configure')
  private awaitingRecovery = false;  // the codec died; frame() holds the last picture until a re-seek lands
  private failStreak = 0;            // consecutive deaths without a frame out between them — sizes the backoff
  private retryAt = 0;               // performance.now() before which a dead decoder is NOT rebuilt
  // Ranged store (step 3): set when pump() stopped because the next sample's GOP is not resident — the
  // read to await. `starvedReads` counts those stops; in healthy play the read-ahead keeps it near 0.
  private starved: Promise<void> | null = null;
  starvedReads = 0;

  // Take a hold on the file's shared parse (see SampleStore). The first holder pays the read and demux;
  // every later one — another pool, another layer on the same clip — attaches to it at once.
  async open(path: string): Promise<Info | null> {
    const st = await acquireStore(path);
    if (!st) return null;
    if (this.store) releaseStore(this.store); // re-opened without a close: never leak the old hold
    this.store = st;
    this.samples = st.samples;
    this.keyframes = st.keyframes;
    this.info = st.info;
    this.durUs = st.info.durationSec * 1e6;
    this.cfg = st.cfg;
    return st.info;
  }

  /**
   * Fill toward `aheadSec` of decoded material at `atSec`, and say whether we got there.
   *
   * Asked by the host's cold-start gate, ~10×/s while it holds the show. `frame()` is what actually
   * runs the pump, so calling it here is the kick — its return value is ignored on purpose: a null
   * (still opening, still decoding) is answered by `have` being short, not by a separate branch.
   *
   * TWO WAYS TO BE SATISFIED, and the second one matters as much as the first:
   *   · enough decoded frames sit at or after `atSec`; or
   *   · the decoder has reached the END OF THE TRACK. A two-second sting cannot produce 0.3 s of
   *     lead beyond its own end, and a gate that insisted would hold the whole show to its timeout
   *     over a clip that is entirely ready. (HAP takes the same view of a permanently-failed frame.)
   */
  preRoll(atSec: number, aheadSec: number): boolean {
    // ⚠ A PRE-ROLL IS A PROBE, NOT A SEEK — AND THIS CALLED frame() UNCONDITIONALLY, WHICH MADE IT BOTH.
    //
    // A timeline layer's decoder has TWO drivers, and only one of them owns the playhead:
    //   · the TRANSPORT (syncCodecLayer → layerFrame) at an advancing clip time — it runs throughout
    //     the cold-start hold, because the gate holds the STATE MACHINE and never writes `playing`;
    //   · this, from the gate's poolReadiness, ~10×/s, always at the START CLIP's time (usually 0).
    //
    // `frame()` moves `wantUs`, so asking at 0 while the transport is at 5 s looked like a BACKWARD
    // SCRUB: pump()'s `wentBackward && !havePresentable` branch fired, seekSegment(0) threw the buffer
    // away, and the transport dragged it forward again before the next poll. Neither ever got its lead.
    // Measured on a 1.5 MB / 145-sample clip: `fedAbs` sawtoothing 21→7→3→8→3, `buffer` oscillating
    // 1↔9, `preRoll` false forever — so the gate armed by TIMEOUT, burning the whole `bootPreloadSec`
    // (15 s by default) on EVERY open of ANY project with an mp4 in its opening scene. Nothing threw
    // and nothing logged; the pending list just said `(buffering)` until the deadline.
    //
    // It also corrupted `lastFrameTs`, which is `layerGeneration` — so every consumer that skips a
    // repeated frame on it (the 3D texture upload, the projector pump) was told the layer had jumped
    // back to the head of the clip ten times a second.
    //
    // So: kick ONLY an idle decoder. When somebody else is already driving this one past the position
    // we would ask for, top it up WHERE IT ACTUALLY IS and report on that — which is the honest
    // readiness question anyway ("is this decoder holding a lead at the point it is being read at"),
    // and is what the gate wanted to know in the first place.
    const askUs = Math.max(0, atSec) * 1e6;
    // `lastWantUs` is whatever the last frame() call asked for, from any caller — so this reads as
    // "another consumer owns the playhead, and it is ahead of us".
    const driven = this.lastWantUs > askUs + EPS_US && this.buffer.length > 0;
    if (driven) this.topUp();          // same feed, same position — never a seek
    else this.frame(atSec, false);     // idle decoder: THE KICK, exactly as before
    const wantUs = driven ? this.wantUs : askUs;
    // ⚠ ASK FOR WHAT THE PUMP WILL ACTUALLY PRODUCE, WHICH IS TARGET_AHEAD — NOT what the requested
    // seconds imply. `pump()` stops feeding at `framesAhead + decodeQueueSize < TARGET_AHEAD`, so the
    // buffer never holds more than ~5 frames ahead no matter how long anyone waits. The first version
    // of this asked for ceil(aheadSec × fps) — 9 frames at 30 fps, 18 at 60 — capped only at
    // MAX_BUFFER, and was therefore UNSATISFIABLE BY CONSTRUCTION: it compiled, nothing threw, and the
    // cold-start gate held every show with an .mp4 in its opening scene to the full timeout while
    // reporting the clip as "buffering". Found only by watching the gate's own pending list.
    //
    // TARGET_AHEAD frames is ~83 ms at 60 fps / ~167 ms at 30 fps of decoded lead. Less than HAP's
    // 300 ms ring, but it is real: the point of the wait is that the decoder is RUNNING and ahead of
    // the playhead, not that it has banked a specific number of milliseconds.
    const fps = this.fps() || 30;
    const want = Math.max(1, Math.min(TARGET_AHEAD, Math.ceil(aheadSec * fps)));
    let have = 0;
    for (const f of this.buffer) if (f.timestamp >= wantUs - EPS_US) have++;
    if (have >= want) return true;
    // End of track: everything that exists is decoded, so this is as ready as it can be.
    const endUs = this.durUs > 0 ? this.durUs : Infinity;
    return wantUs + aheadSec * 1e6 >= endUs && this.buffer.length > 0;
  }

  // Resident bytes THIS decoder adds: a nominal 4:2:0 estimate for its decoded frames in flight. The
  // encoded samples are NOT counted here — they belong to the shared SampleStore and are counted once at
  // module level (residentBytes), or N decoders on one file would report N copies that do not exist.
  residentBytes(): number {
    const px = this.info ? this.info.width * this.info.height : 0;
    return this.buffer.length * px * 1.5;
  }

  getInfo(): Info | null { return this.info; }
  aspect(): number | null { return this.info && this.info.width > 0 ? this.info.width / this.info.height : null; }
  /**
   * Nominal frame rate, derived from the sample count over the track duration. ONE formula: preRoll
   * sizes its lead with it and an export sizes its output rate with it, and two derivations of "how
   * fast is this file" would disagree on exactly the variable-frame-rate files where it matters.
   * Returns 0 when it cannot be known (a single-sample or duration-less track) — callers decide the
   * fallback rather than inheriting a made-up 30 from here.
   */
  fps(): number {
    return this.samples.length > 1 && this.durUs > 0 ? this.samples.length / (this.durUs / 1e6) : 0;
  }

  /**
   * THE EXACT frame covering `timeSec`, awaited. For NON-REALTIME callers only.
   *
   * ⚠ WHY THIS EXISTS ALONGSIDE frame(). Every playback accessor in this file is deliberately
   * non-blocking: `frame()` pumps, then takes the best decoded frame it has and — right after a seek,
   * when it has none at the playhead — falls back to "the earliest buffered frame so we show
   * something". That is correct for a show, where a frame either side beats a black projector. It is
   * wrong for anything that WRITES what it is given: a renderer cannot tell a near-miss from a hit,
   * and the result is a file with the wrong pictures in it that nobody notices until it is on a wall.
   *
   * So this one waits. It drives the SAME pump (one feeding implementation — the decode-order rule,
   * the seek branches and the pacing all live there and must not be reimplemented here), draining with
   * `flush()` between rounds until the feed has genuinely passed the target, and only then answers.
   * `flush()` emits pending frames WITHOUT resetting, so the next round continues decoding deltas from
   * where this one stopped rather than re-seeking to the keyframe.
   *
   * EXACT OR NOTHING: a time outside the track resolves null rather than clamping to the first or last
   * frame. A render that clamped would silently repeat the end frame for the rest of its range, which
   * reads as a freeze and gets blamed on the encoder.
   *
   * The returned frame is BORROWED — it lives in this decoder's buffer and is closed on eviction, so
   * draw it before asking for the next one. Same contract as frame().
   */
  async frameExact(timeSec: number): Promise<VideoFrame | null> {
    const N = this.samples.length;
    if (!N) return null;
    const timeUs = Math.round(timeSec * 1e6);
    if (timeUs < 0) { console.warn('[mp4/exact] negative time', timeSec); return null; }
    if (this.durUs > 0 && timeUs >= this.durUs) { console.warn('[mp4/exact] past end', timeUs, 'dur', this.durUs); return null; }
    // Not ensureDecoder(): pump() below reaches seekSegment (idle ⇒ segAbs === -1), which is the one door
    // to a configured decoder. Building one here is what used to hand pump() an unconfigured codec.
    if (!this.cfg) { console.warn('[mp4/exact] no decoder'); return null; }

    // ⚠ THE TARGET COMES FROM THE CONTAINER, NOT FROM THE DECODER.
    // The first version of this asked "what is the best decoded frame at or before the target, now
    // that the feed has passed it" — which is a question about the BUFFER, and the buffer lies at the
    // end of a track: nothing is left to feed, eviction has already retired the wanted frame, and the
    // best remaining answer is a stale earlier one. It returned frame 43 for frames 44, 45 and 46,
    // confidently. Deriving the wanted presentation time from the sample table instead makes the
    // answer checkable — we either hold that exact frame or we do not — and a miss becomes a re-seek
    // rather than a plausible wrong picture.
    const targetTs = this.presentationTsAt(timeUs);
    if (targetTs === null) { console.warn('[mp4/exact] no target ts; samples=', N, 'timeUs=', timeUs); return null; }

    let flushed = false;
    let reseeked = false;
    for (let round = 0; round < EXACT_MAX_ROUNDS; round++) {
      // Non-looping: a render addresses clip-local time, so the pump caps at the last sample and
      // never wraps. Mirroring frame()'s bookkeeping keeps topUp() and the backward-jump detector
      // coherent if anything else touches this decoder afterwards.
      this.wantUs = timeUs;
      this.pump(false, 0, timeUs);
      this.lastPump = { loop: false, loopCount: 0, localUs: timeUs };
      this.lastWantUs = timeUs;

      const dec = this.decoder;
      // Dead and recovering: yield and go round. Waiting is safe here in a way it is not for playback —
      // the answer is matched against the container's own target timestamp below, so a recovered decoder
      // can only ever return the exact frame, and EXACT_MAX_ROUNDS still ends a render that never gets one.
      if (!dec || dec.state !== 'configured') {
        if (!this.awaitingRecovery) return null;
        await new Promise<void>((r) => { setTimeout(r, 0); });
        continue;
      }

      // ⚠ NOT `===`. `samples[].ts` is `(cts / timescale) * 1e6` and is routinely FRACTIONAL, while an
      // EncodedVideoChunk timestamp is a `long long` — so the value that comes back out of the decoder
      // has been coerced to an integer and can never equal the target exactly. Strict equality here
      // matched nothing and spun the loop until it gave up. A 2 µs window absorbs the coercion and is
      // still four orders of magnitude tighter than the gap between adjacent frames, so it cannot
      // admit a neighbour — which is the only thing that would make this approximate.
      for (const f of this.buffer) {
        if (Math.abs(f.timestamp - targetTs) <= 2) { this.lastFrameTs = f.timestamp; return f; }
      }

      // The feed stopped at a GOP whose bytes are still being read: wait for THAT read rather than
      // spending rounds on zero-delay yields (a 9 MB GOP read takes milliseconds, a round is ~4 ms).
      if (this.starved) { const w = this.starved; this.starved = null; await w; continue; }

      const drained = dec.decodeQueueSize === 0;
      const fedAll = this.fedAbs >= N - 1;

      // ⚠ DRAIN BY WAITING, NOT BY FLUSHING — this cost a round of the harness to find.
      // `flush()` looks like the obvious way to force the queue out, and it does; but a flushed
      // VideoDecoder treats what follows as a discontinuity, so every delta fed afterwards decoded to
      // nothing and the buffer stopped advancing — the same stale picture for every later time, which
      // is exactly the silent corruption this method exists to prevent, arriving through the fix for
      // it. The decoder empties its queue on its own; yielding is enough. ONE flush is legitimate at
      // the end of the track, where frames sit in the reorder queue with nothing left to push them out.
      if (fedAll && !drained && !flushed) {
        flushed = true;
        try { await dec.flush(); } catch { return null; }
        continue;
      }
      // Fed everything, decoded everything, and still not holding it: eviction retired it while the
      // playhead moved on. Restart the segment from the keyframe covering the target and decode
      // forward again — the one case where an offline render pays for a seek it could not avoid.
      if (fedAll && drained) {
        if (reseeked) { console.warn('[mp4/exact] gave up after reseek; target', targetTs, 'buffer', this.buffer.map((f) => f.timestamp).join(','), 'fedAbs', this.fedAbs, 'N', N); return null; }
        reseeked = true;
        this.segAbs = -1;            // pump() re-anchors on the covering keyframe next round
        continue;
      }

      await new Promise<void>((r) => { setTimeout(r, 0); });
    }
    console.warn('[mp4/exact] rounds exhausted; target', targetTs, 'fedAbs', this.fedAbs);
    return null;
  }

  /**
   * The presentation time of the frame ON SCREEN at `timeUs`, straight from the demuxed sample table.
   *
   * Decoder-independent on purpose (see frameExact). `samples` is in DECODE order, so the times are
   * not sorted and this keeps a sorted copy — built once per file, ~8 bytes a frame, which is nothing
   * beside the encoded samples already held.
   */
  private presentationTsAt(timeUs: number): number | null {
    if (!this.sortedCts) this.sortedCts = this.samples.map((s) => s.ts).sort((a, b) => a - b);
    const a = this.sortedCts;
    if (!a.length) return null;
    let lo = 0, hi = a.length - 1, best: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (a[mid] <= timeUs + PRESENT_EPS_US) { best = a[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    // ⚠ BEFORE THE FIRST PRESENTATION TIME, THE FIRST FRAME IS WHAT IS ON SCREEN.
    //
    // A track's earliest `cts` is routinely NOT zero: with B-frames the first frame's presentation is
    // delayed by a frame or two, and the container carries an edit list to compensate. So clip-local
    // time 0 has nothing at or before it, and answering null there refused every render whose first
    // track was ordinary B-frame H.264 — measured on a real show: 145 samples, none at or before 0.
    //
    // This is NOT the approximation this method exists to refuse. `frame()` resolves the same case the
    // same way ("if none is ready yet, fall back to the earliest"), and matching it is the point: an
    // offline render must pick the frame live playback would at the same instant, or the two cannot be
    // diffed against each other to prove the render correct.
    return best ?? a[0];
  }

  // ⚠ CALLED ONLY FROM seekSegment(), which configures what this returns before anything feeds it. It
  // used to be called from pump() and frameExact() as well, and that was the freeze: after a codec died
  // this built a fresh UNCONFIGURED decoder, a forward-playing surface never reached seekSegment, and
  // pump() fed it chunk after chunk — every decode() threw, the catch swallowed it, and with
  // `maxAbs = Infinity` nothing ended the loop. Measured on the RTX box: one core at 100%, renderer
  // memory +6 GB/s (each pass copies a sample into a new EncodedVideoChunk), dead of OOM at ~14.8 GB in
  // 4.7 s — from an injected fault and from a real GPU-process crash alike. A decoder that reaches the
  // feed is now one seekSegment configured, and nothing else.
  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    if (!this.cfg) return null;
    const dec: VideoDecoder = new VideoDecoder({
      output: (frame) => {
        // Insert keeping the buffer ordered by (absolute) presentation timestamp.
        if (this.buffer.length && frame.timestamp < this.buffer[this.buffer.length - 1].timestamp) {
          let i = this.buffer.length;
          while (i > 0 && this.buffer[i - 1].timestamp > frame.timestamp) i--;
          this.buffer.splice(i, 0, frame);
        } else {
          this.buffer.push(frame);
        }
        // A frame out of a rebuilt decoder is the only honest proof that recovery worked — a configure()
        // that returns says the codec accepted a config, not that it can decode this file on this GPU.
        if (this.awaitingRecovery) {
          this.awaitingRecovery = false;
          this.recoveries++;
          console.info(`[mp4] decoder recovered after ${this.failStreak} failure(s)`);
          this.failStreak = 0;
        }
        this.evict();
      },
      // Only the CURRENT decoder's death matters. A callback from one we already replaced is history:
      // recording it is honest, acting on it would kill the healthy successor.
      error: (e) => { if (this.decoder === dec) this.markDead('decode', e); else this.noteError('decode', e, true); },
    });
    this.decoder = dec;
    return dec;
  }

  // One place a failure is recorded, so the stats and the log line cannot disagree. The log text is
  // what both call sites printed before this existed.
  private noteError(what: 'decode' | 'configure', e: { name?: string; message: string }, quiet = false): void {
    this.errors++;
    this.lastError = `${what}: ${e.name ?? 'Error'}: ${e.message}`;
    if (!quiet) console.warn(what === 'decode' ? '[mp4] decode error' : '[mp4] configure failed', e.message);
  }

  /**
   * The codec is dead (a decode error, a GPU reset, a reclaim, a configure that threw, or a decode()
   * that threw). Drop it and arrange for the next pump() to rebuild it AT THE PLAYHEAD.
   *
   * `segAbs = -1` is the whole mechanism: it is the "idle" state, so pump()'s first branch re-seeks to
   * the keyframe covering wherever the playhead is by then — the same door a cold open takes. `buffer`
   * is KEPT: VideoFrames already output stay valid after their codec closes, so frame() keeps showing
   * the last good picture while the rebuild decodes forward (≤ one GOP).
   *
   * BACKOFF, because a file that will never decode — or a GPU that is still gone — must not rebuild a
   * hardware decoder sixty times a second. The first retry is immediate (a reset or a reclaim recovers
   * on the first try), then 250 ms doubling to a 5 s ceiling, cleared by the first frame out. There is no
   * terminal "give up": a retry every 5 s costs nothing, and it is what brings a decoder back on its own
   * once the driver does. The log follows the same shape — the first three, then about once a minute.
   */
  private markDead(what: 'decode' | 'configure', e: { name?: string; message: string }): void {
    this.failStreak++;
    const loud = this.failStreak <= 3 || this.failStreak % 12 === 0;
    this.noteError(what, e, !loud);
    const dec = this.decoder;
    this.decoder = null;
    if (dec && dec.state !== 'closed') { try { dec.close(); } catch { /* */ } }
    this.segAbs = -1;
    this.awaitingRecovery = true;
    this.retryAt = performance.now() + (this.failStreak <= 1 ? 0 : Math.min(5000, 125 * 2 ** (this.failStreak - 1)));
  }

  /**
   * TEST-ONLY fault injection, reached through `__artluxMp4Fault`. Inert unless called.
   *
   * `close` puts the codec in exactly the state a WebCodecs error leaves it in (`state === 'closed'`)
   * without running the error callback — a decoder that died without telling us. `error` does the
   * same and then runs the real handler, which is the full path a GPU reset or a reclaim takes.
   * `configure` makes the next configure() throw, the second way into the same spin (seekSegment).
   * Returns false when there is no live codec to hurt.
   */
  injectFault(kind: Mp4FaultKind): boolean {
    if (kind === 'configure') { this.failNextConfigure = true; return true; }
    const dec = this.decoder;
    if (!dec || dec.state === 'closed') return false;
    try { dec.close(); } catch { /* */ }
    if (kind === 'error') this.markDead('decode', { name: 'InjectedError', message: 'injected by __artluxMp4Fault' });
    return true;
  }

  // `samples`/`keyframes` because a recovery re-seeks to the covering keyframe, so how far it can jump
  // back (and how long it takes to decode forward again) is set by the file's GOP length, not by us.
  stats(): {
    state: string; samples: number; keyframes: number; segAbs: number; fedAbs: number; buffered: number; queue: number;
    errors: number; lastError: string | null; recovering: boolean; recoveries: number; failStreak: number; retryInMs: number; feedCapHits: number; starvedReads: number; lastFrameMs: number | null;
  } {
    return {
      state: this.decoder?.state ?? 'none', samples: this.samples.length, keyframes: this.keyframes.length,
      segAbs: this.segAbs, fedAbs: this.fedAbs, buffered: this.buffer.length,
      queue: this.decoder && this.decoder.state !== 'closed' ? this.decoder.decodeQueueSize : 0,
      errors: this.errors, lastError: this.lastError,
      recovering: this.awaitingRecovery, recoveries: this.recoveries, failStreak: this.failStreak,
      retryInMs: this.awaitingRecovery ? Math.max(0, Math.round(this.retryAt - performance.now())) : 0,
      feedCapHits: this.feedCapHits, starvedReads: this.starvedReads,
      lastFrameMs: this.lastFrameTs === null ? null : Math.round(this.lastFrameTs / 1000), // the picture last handed out
    };
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
    try {
      if (this.failNextConfigure) { this.failNextConfigure = false; throw new Error('injected by __artluxMp4Fault'); }
      dec.configure(this.cfg!);
    } catch (e) {
      // The second way into the freeze: this used to log and return with the decoder UNCONFIGURED and
      // pump() went on to feed it. A codec that refuses its config is as dead as one that errored.
      this.markDead('configure', e as Error);
      return;
    }
    if (this.buffer.length > 1) {
      const hold = this.buffer[this.buffer.length - 1]; // highest ts (sorted asc) = most recent
      for (let i = 0; i < this.buffer.length - 1; i++) this.buffer[i].close();
      this.buffer = [hold];
    }
    this.segAbs = absKf;
    this.fedAbs = absKf - 1;
  }

  // ── REFILLING MUST NOT DEPEND ON BEING ASKED ────────────────────────────────────────────────────
  // `pump()` used to run ONLY from `frame()`, so the rate at which this decoder refilled was the rate
  // at which some consumer happened to ask it for a picture. That coupling is invisible until the ask
  // rate changes: v0.25.2 capped the engine at 30 Hz and a cold clip entry — buffer empty, everything
  // to decode at once — took twice as long to produce a presentable frame, which on the wall reads as
  // most of a second of missing video.
  //
  // `topUp()` re-runs the feed at the playhead already requested, from this module's own rAF. Safe to
  // call between frame()s by construction: `wantUs` has not moved, so `wentBackward` is false and no
  // branch re-seeks — it only tops the queue back up toward TARGET_AHEAD as decoded frames drain.
  topUp(): void {
    const a = this.lastPump;
    if (a) this.pump(a.loop, a.loopCount, a.localUs);
  }
  private lastPump: { loop: boolean; loopCount: number; localUs: number } | null = null;

  // Feed the decoder (in DECODE order, across the loop boundary when `loop`) to keep ~TARGET_AHEAD frames
  // decoded-or-in-flight past the playhead. Re-seeks ONLY on a backward jump (scrub) or a big forward jump.
  private pump(loop: boolean, loopCount: number, localUs: number): void {
    const N = this.samples.length;
    if (!N) return;
    // A codec can be closed without its error callback ever running (Chromium tears codecs down on its
    // own terms; __artluxMp4Fault('close') does it on purpose). Closed is dead, whoever closed it.
    if (this.decoder && this.decoder.state === 'closed' && !this.awaitingRecovery) {
      this.markDead('decode', { name: 'InvalidStateError', message: 'decoder closed without reporting an error' });
    }
    // Dead and still backing off: hold the last picture (evict keeps KEEP_BEHIND frames) and feed nothing.
    if (this.awaitingRecovery && performance.now() < this.retryAt) { this.evict(); return; }
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

    // ⚠ FEED ONLY A CONFIGURED DECODER — never build one here (see ensureDecoder). If the seek above did
    // not leave one (its configure threw → markDead, or we are still backing off), there is nothing to
    // feed this call; an unconfigured codec that is not dead is put back on the re-seek path.
    const dec = this.decoder;
    if (!dec || dec.state !== 'configured') {
      if (!this.awaitingRecovery) this.segAbs = -1;
      this.evict();
      return;
    }
    const maxAbs = loop ? Infinity : N - 1; // don't loop-feed a timeline layer / thumbnail
    let framesAhead = 0;
    for (const f of this.buffer) if (f.timestamp > this.wantUs) framesAhead++;
    // ⚠ THE PER-CALL BOUND. Every other exit condition below measures decoder PROGRESS, and a codec that
    // throws on every call makes none — which is how this loop ran forever. A healthy feed never reaches
    // the bound: decode() raises decodeQueueSize synchronously, so the TARGET_AHEAD term ends the loop
    // after at most TARGET_AHEAD chunks. `feedCapHits` counts the times the bound did the stopping.
    // READ-AHEAD: name the window this decoder is about to feed — its GOP and GOP_AHEAD after it,
    // wrapping for a looping surface — so the store reads what is missing while the GOP in hand decodes.
    // Cheap when resident (a few map lookups); a no-op for a store parsed whole.
    const st = this.store;
    if (st) st.want(((this.fedAbs + 1) % N + N) % N, maxAbs === Infinity);
    let budget = QUEUE_BUDGET;
    while (this.fedAbs < maxAbs && dec.decodeQueueSize < QUEUE_BUDGET && framesAhead + dec.decodeQueueSize < TARGET_AHEAD) {
      if (budget-- <= 0) { this.feedCapHits++; break; }
      const next = this.fedAbs + 1;
      const local = ((next % N) + N) % N;
      // ⚠ BYTES NOT RESIDENT YET → STOP, DON'T SKIP. Advancing fedAbs past a sample whose bytes we do not
      // have would feed every later delta against a missing reference. Hold here (the buffer keeps the
      // picture) and pick up from this exact sample when the GOP read lands — `starved` lets an awaiting
      // caller (frameExact, thumbnail) wait for that instead of polling.
      const data = st ? st.dataOf(local) : null;
      if (!data) { this.starvedReads++; this.starved = st ? st.request(st.gopOf(local)) : null; break; }
      this.starved = null;
      this.fedAbs = next;
      const s = this.samples[local];
      const ts = this.tsOfAbs(next);
      try { dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: ts, duration: s.dur, data })); }
      catch (e) {
        // RE-SEEK, DON'T SKIP. Skipping one chunk used to mean every frame after it decoded against a
        // missing reference until the next keyframe; and a throw here usually means the codec itself is
        // unusable, which a skip turns into the spin. Rebuild at the playhead instead.
        this.markDead('decode', e as Error);
        break;
      }
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
    this.lastPump = { loop: loop && this.durUs > 0, loopCount, localUs };
    this.lastWantUs = this.wantUs; // for next call's backward-jump detection

    // Prefer the latest decoded frame at/just-before the playhead (never show a future frame); if none is
    // ready yet (right after a seek), fall back to the earliest buffered frame so we show something.
    let best: VideoFrame | null = null;
    for (const f of this.buffer) {
      if (f.timestamp <= this.wantUs + PRESENT_EPS_US) { if (!best || f.timestamp > best.timestamp) best = f; }
    }
    if (!best) for (const f of this.buffer) { if (!best || f.timestamp < best.timestamp) best = f; }
    // Remember WHICH decoded frame this was, so consumers can tell a fresh frame from a repeat — a
    // 25 fps clip sampled by a 60 Hz loop is more than half repeats. Absolute-monotonic across loop
    // wraps because tsOfAbs() folds the loop count into the timestamp, so it never goes backward
    // during playback and a repeat is exactly an equal value. See generation() below.
    this.lastFrameTs = best ? best.timestamp : null;
    return best;
  }

  close(): void {
    for (const f of this.buffer) f.close();
    this.buffer = [];
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch { /* */ }
    this.decoder = null; this.segAbs = -1; this.fedAbs = -1; this.lastWantUs = -Infinity; this.lastFrameTs = null;
    this.awaitingRecovery = false; this.failStreak = 0; this.retryAt = 0; // a closed decoder is not "recovering"
    // Let go of the shared parse. A closed FileDecoder is never reused (every caller drops it from its
    // pool), so the references go too — otherwise a decoder object still reachable somewhere would pin
    // the whole track after its store had been released.
    if (this.store) { releaseStore(this.store); this.store = null; }
    this.samples = []; this.keyframes = []; this.sortedCts = null; this.starved = null;
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

// ── THE SELF-PUMP ───────────────────────────────────────────────────────────────────────────────
// Keeps every open surface/layer decoder topped up on this module's own clock instead of on whatever
// rate its consumer happens to ask at. Thumbnail decoders are excluded on purpose: a filmstrip is
// scrubbed, not played, so there is no playhead running away from its buffer.
//
// Runs only while a decoder is open, and does nothing per decoder once the queue is at TARGET_AHEAD —
// the `while` in pump() exits immediately — so the idle cost is a map walk per frame.
let pumpRaf = 0;
function selfPump(): void {
  pumpRaf = 0;
  for (const d of decoders.values()) d.topUp();
  for (const { dec } of layerDecoders.values()) dec.topUp();
  if (decoders.size || layerDecoders.size) pumpRaf = requestAnimationFrame(selfPump);
}
function ensurePump(): void { if (!pumpRaf && (decoders.size || layerDecoders.size)) pumpRaf = requestAnimationFrame(selfPump); }
const results = new Map<string, boolean>(); // probed: true = decodable MP4, false = not (fall back to <video>)

const layerDecoders = new Map<string, { dec: FileDecoder; path: string }>(); // key = layerId
const layerOpening = new Map<string, Promise<Info | null>>();

const thumbDecoders = new Map<string, FileDecoder>();
const thumbOpening = new Map<string, Promise<Info | null>>();

// ⚠ THUMBNAIL DECODERS HAD NO RELEASE PATH AT ALL. `decoders` is refcounted by the host
// (services/codecResidency) and `layerDecoders` is freed by releaseLayer — but nothing ever closed a
// thumb decoder, and each one holds every encoded sample of its file so seeks are instant. Scrubbing a
// filmstrip across a 24-clip library therefore accumulated 24 whole tracks, permanently.
//
// This was visible in the residency probe before it was understood: codec-resident bytes climbed past
// the size of the entire media pool, which is only possible if one file is resident several times over.
// A filmstrip is a LOOK, not the show, so it gets the smallest budget that still lets a strip fill
// without reopening on every slot — the LRU keeps the last few files scrubbed.
const MAX_THUMB_DECODERS = 4;

function trimThumbDecoders(): void {
  while (thumbDecoders.size > MAX_THUMB_DECODERS) {
    const oldest = thumbDecoders.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    thumbDecoders.get(oldest)?.close();
    thumbDecoders.delete(oldest);
  }
}

export function ensureOpen(path: string): Promise<Info | null> {
  const existing = opening.get(path);
  if (existing) return existing;
  if (decoders.has(path)) return Promise.resolve(decoders.get(path)!.getInfo());
  const d = new FileDecoder();
  const p = d.open(path).then((info) => {
    if (info) { decoders.set(path, d); ensurePump(); } else d.close();
    results.set(path, info !== null);
    opening.delete(path);
    return info;
  });
  opening.set(path, p);
  return p;
}

export function probed(path: string): boolean | undefined { return results.get(path); }

// ── THE INDEX-ONLY PROBE ─────────────────────────────────────────────────────────────────────────
// "Can WebCodecs play this file, and what is it?" — answered from the container's INDEX alone.
//
// ⚠ probe() USED TO BE ensureOpen(): a full surface decoder — every encoded sample of the track read
// into the renderer — that NO residency owner held, so nothing ever closed it. Every caller that only
// wanted the verdict paid for it: the thumbnail pump probes each job, and the timeline probes every
// codec clip it syncs. Measured 2026-10-23 on a 1.36 GB clip that sat in the library and nowhere else:
// one thumbnail request left an unowned surface decoder (plus the thumbnail decoder), +2.3 GB of
// ArrayBuffer storage, half of it for the rest of the session.
//
// The index is a few hundred KB at either end of the file, and mp4box can find it without the frames:
// before it has seen a `moov` it skips an `mdat` box and asks for the byte just past it (its
// `nextParsePosition`, which appendBuffer returns). So: fetch a small range, append it, go where the
// parser asks, grow the range while the parser is inside a box it needs whole — and stop at onReady.
// The media protocol answers Range requests (measured 1–3 ms per 206). Nothing here is retained but
// the verdict and the few numbers below.
interface IndexInfo { info: Info; fps: number }
const indexCache = new Map<string, IndexInfo | null>();
const indexProbing = new Map<string, Promise<IndexInfo | null>>();
const INDEX_FIRST_CHUNK = 256 * 1024;
const INDEX_MAX_CHUNK = 8 * 1024 * 1024;
const INDEX_MAX_FETCHES = 64; // a moov is found in 2–3 fetches; this only stops a malformed file looping

// Parse a file's moov by byte range. 'missing' = refused/absent (a verdict); null = no moov found this way.
// Shared by the probe (metadata only) and loadStore (the sample table) — one ranged reader, not two.
type IndexRead = { file: MP4File; track: MP4VideoTrack; mp4: MP4Info };
async function readIndex(url: string): Promise<IndexRead | 'missing' | null> {
  const file: MP4File = MP4Box.createFile();
  let ready: IndexRead | null = null;
  let failed = false;
  file.onError = () => { failed = true; };
  file.onReady = (mp4: MP4Info) => {
    const track: MP4VideoTrack | undefined = mp4.videoTracks?.[0];
    if (!track) { failed = true; return; }
    ready = { file, track, mp4 };
  };
  let pos = 0;
  let chunk = INDEX_FIRST_CHUNK;
  let size = Infinity;
  for (let n = 0; n < INDEX_MAX_FETCHES && !ready && !failed && pos < size; n++) {
    let buf: ArrayBuffer;
    try {
      const end = Math.min(pos + chunk, size) - 1;
      const res = await fetch(url, { headers: { Range: `bytes=${pos}-${end}` } });
      if (!res.ok) return 'missing'; // refused / missing: a verdict, not a hang (see loadWholeStore)
      const total = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
      if (total) size = Number(total[1]);
      buf = await res.arrayBuffer();
    } catch { return null; }
    if (!buf.byteLength) return 'missing';
    (buf as ArrayBuffer & { fileStart?: number }).fileStart = pos;
    const next = file.appendBuffer(buf as ArrayBuffer & { fileStart: number });
    if (ready || failed) break;
    const after = pos + buf.byteLength;
    if (next > after) { pos = next; chunk = INDEX_FIRST_CHUNK; } // skipped a box (an mdat before the moov)
    else { pos = after; chunk = Math.min(INDEX_MAX_CHUNK, chunk * 2); } // inside a box it needs whole: read on
  }
  return ready;
}

async function probeIndex(path: string): Promise<IndexInfo | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  const url = resolveMediaUrl(path);
  if (!url) return null;
  const ix = await readIndex(url);
  if (!ix || ix === 'missing') return null;
  const { file, track, mp4 } = ix;
  const durationSec = mp4.duration && mp4.timescale ? mp4.duration / mp4.timescale : 0;
  // The SAME derivation as FileDecoder.fps() (sample count over duration). A fragmented file's moov
  // carries no sample table, so its count is unknown here — reported as 0, which sourceInfo turns
  // into "absent" rather than a plausible 30 (see the note there).
  const fps = !mp4.isFragmented && track.nb_samples > 1 && durationSec > 0 ? track.nb_samples / durationSec : 0;
  const cfg = trackConfig(file, track);
  // Same question loadStore asks before claiming a file, on the same config — a track that demuxes but
  // cannot be configured must decline HERE, or the host drops its <video> fallback for it.
  try {
    const s = await VideoDecoder.isConfigSupported(cfg);
    if (!s.supported) { console.info('[mp4] declining', path, '— WebCodecs cannot configure', cfg.codec); return null; }
  } catch { return null; }
  return { info: { width: track.video.width, height: track.video.height, durationSec }, fps };
}

/**
 * "Is this a file WebCodecs can play?" — WITHOUT opening a decoder (see the section above).
 *
 * A file some pool already has open is answered from it. Otherwise the index probe runs once per path
 * and its verdict is kept, so `probed()` answers synchronously from then on. `ensureOpen()` writes the
 * same `results` map, so either door leaves the host the same answer.
 */
export function probe(path: string): Promise<boolean> {
  if (stores.has(path)) { results.set(path, true); return Promise.resolve(true); } // already parsed and judged
  if (indexCache.has(path)) return Promise.resolve(indexCache.get(path) !== null);
  let p = indexProbing.get(path);
  if (!p) {
    p = probeIndex(path).then((r) => {
      indexCache.set(path, r);
      // Do not overwrite a verdict a full open already reached — that one judged the whole file.
      if (!results.has(path)) results.set(path, r !== null);
      indexProbing.delete(path);
      return r;
    });
    indexProbing.set(path, p);
  }
  return p.then((r) => r !== null);
}

// Roughly what is held for `path` across the three pools, for the host's residency budget
// (services/codecResidency). The dominant term is `samples` — open() keeps EVERY encoded sample of
// the track resident so seeks are instant, which for a long clip is most of the file. That is exactly
// what a pool-counting budget could not see: one warm pool can be tens of megabytes or hundreds.
// Decoded VideoFrames are counted at their nominal 4:2:0 size; the real GPU allocation is opaque.
export function residentBytes(path: string): number {
  // The shared parse ONCE, plus each decoder's own decoded frames.
  let n = stores.get(path)?.bytes ?? 0;
  const add = (d: FileDecoder | undefined) => { if (d) n += d.residentBytes(); };
  add(decoders.get(path));
  add(thumbDecoders.get(path));
  for (const { dec, path: p } of layerDecoders.values()) if (p === path) add(dec);
  return n;
}
export function frame(path: string, timeSec: number): VideoFrame | null { return decoders.get(path)?.frame(timeSec, true) ?? null; }
export function aspect(path: string): number | null {
  const open = decoders.get(path)?.aspect();
  if (open) return open;
  // A parsed or probed file knows its shape without a decoder.
  const ix = stores.get(path)?.info ?? indexCache.get(path)?.info;
  return ix && ix.width > 0 && ix.height > 0 ? ix.width / ix.height : null;
}
// "Has this surface got NEW pixels?" — the absolute timestamp of the frame the last frame() call
// returned, or undefined before the first one. Only the SURFACE pool (`decoders`) is asked; layer and
// thumbnail decoders have their own playheads and no consumer of this.
//
// This is what lets the repeat-skips downstream actually fire: without it every consumer must assume
// every frame is new, so a 25 fps clip pays a full-resolution GPU upload per view AND a whole-surface
// createImageBitmap per projector window at display rate. HAP has always reported one; WebCodecs did
// not, so the optimisation was dead for every .mp4 — which is the default codec.
export function generation(path: string): number | undefined {
  const ts = decoders.get(path)?.lastFrameTs;
  return ts === null || ts === undefined ? undefined : ts;
}
// The host's closeSurface — reached when the LAST residency owner of `path` lets go (codecResidency.
// release). That is also when a pre-warm hold must go: the pool that asked for it is the owner that just
// left, so the hold is released here rather than tracked a second time.
export function close(path: string): void {
  decoders.get(path)?.close(); decoders.delete(path); results.delete(path);
  const warm = warmHolds.get(path);
  if (warm) { warmHolds.delete(path); releaseStore(warm); }
  warmLoading.delete(path); // a pre-warm still loading must not keep its hold when it lands (see prewarm)
}

// ── PRE-WARM HOLDS THE PARSE, NOT A DECODER ─────────────────────────────────────────────────────
// The timeline pre-warms the clips a pool is about to need (timeline.ts warmWindow / warmMedia / the
// cold-start gate). For mp4 that used to be ensureOpen(): a SURFACE decoder — a full copy of the
// track — which a timeline layer never reads (layers read layerDecoders). Its one real effect was
// indirect: the file was read once, so the layer's own open later found it in the OS cache.
//
// Now the hold is on the shared SampleStore itself, which is strictly better than both: no copy nobody
// reads, and when the layer opens at the cut it attaches to the parse already in memory — no read and
// no demux at all. One hold per path, idempotent; released by close(path) above.
const warmHolds = new Map<string, SampleStore>();
const warmLoading = new Set<string>();
export function prewarm(path: string): void {
  if (warmHolds.has(path) || warmLoading.has(path)) return;
  warmLoading.add(path);
  void acquireStore(path).then((st) => {
    // close(path) removes the path from warmLoading. If it is gone, close ran while this was loading
    // (the pool was demoted before the parse landed): nobody owns the path any more, so a hold kept now
    // would be one nobody ever releases.
    const stillWanted = warmLoading.delete(path);
    if (!st) { results.set(path, false); return; }
    results.set(path, true);
    if (!stillWanted || warmHolds.has(path)) { releaseStore(st); return; }
    warmHolds.set(path, st);
  });
}

// Timeline layer: a dedicated, non-looping (seekable) decoder per layerId. Lazily opened; returns null
// until ready. `clipTimeSec` is clip-local (already includes in-point) — a scrub seeks frame-exactly.
export function layerFrame(layerId: string, path: string, clipTimeSec: number): VideoFrame | null {
  const cur = layerDecoders.get(layerId);
  if (cur && cur.path === path) return cur.dec.frame(clipTimeSec, false);
  ensureLayerOpen(layerId, path);
  return null; // opening
}

/**
 * Open the LAYER decoder for `layerId` ahead of time, without asking for a frame.
 *
 * ⚠ THIS IS THE HALF THAT WAS MISSING, AND WITHOUT IT A PRE-ROLL FIXES NOTHING. `preWarm(path)` opens
 * the SURFACE decoder, which is keyed by path; a timeline layer uses a DIFFERENT decoder keyed by
 * layerId, created lazily on the first `layerFrame` call — which returns null while it opens. So on an
 * H.264 show the cold-start gate armed, the swap promoted, `syncCodecLayer` asked for a frame, got
 * null, and the layer was black for the whole duration of an open (a full demux). The gate was
 * measuring a decoder nobody was about to read from.
 *
 * Extracted from layerFrame's own lazy path so both go through one door — a second open() for the same
 * layer would be a second full copy of the track's samples.
 */
export function ensureLayerOpen(layerId: string, path: string): void {
  const cur = layerDecoders.get(layerId);
  if (cur && cur.path === path) return;
  if (cur) { cur.dec.close(); layerDecoders.delete(layerId); } // clip on this layer changed file
  if (layerOpening.has(layerId)) return;
  const nd = new FileDecoder();
  const p = nd.open(path).then((info) => { if (info) { layerDecoders.set(layerId, { dec: nd, path }); ensurePump(); } else nd.close(); layerOpening.delete(layerId); return info; });
  layerOpening.set(layerId, p);
}

/**
 * "Is there a decoded BUFFER here, not just a first frame?" — the cold-start gate's question.
 *
 * A codec that decodes ahead starts EMPTY, so a show armed on "the first frame exists" opens by
 * missing the next hundred: measured on HAP, 167 ring misses in the first ten seconds. HAP has
 * answered this since that measurement; **mp4 — the DEFAULT codec — never did**, so the guarantee
 * silently did not apply to H.264/H.265 at all.
 *
 * Kicks the work as well as reporting it (the SDK contract): the gate polls ~10×/s while holding, and
 * that polling is what fills the buffer.
 *
 * ⚠ A DELIBERATE DEVIATION ON DEPTH, and it is not the constant being ignored. The gate asks for
 * PREROLL_SEC (0.3 s) which at 60 fps is 18 frames — but MAX_BUFFER is 12, because holding many live
 * 4K VideoFrames stalls NVDEC (see the constants above). Starving the hardware decoder to satisfy a
 * number would trade a real stall for a nominal one, so the target is capped — at TARGET_AHEAD (5),
 * not MAX_BUFFER-1: an 11-frame target was unsatisfiable, because pump() never feeds past
 * TARGET_AHEAD (see the ⚠ in the body). 5 frames is ~83 ms at 60 fps / ~167 ms at 30 — less than
 * HAP's 300 ms ring. (This comment said "11 frames, ~180 ms" until 2026-10-22.)
 */
export function preRoll(path: string, atSec: number, aheadSec: number, layerId?: string): boolean {
  const dec = layerId ? layerDecoders.get(layerId)?.dec : decoders.get(path);
  if (!dec) {
    // Not open yet — kick it and report "not ready". The gate's next poll asks again.
    if (layerId) ensureLayerOpen(layerId, path); else void ensureOpen(path);
    return false;
  }
  return dec.preRoll(atSec, aheadSec);
}

// Layer twin of generation(): the same per-decoder lastFrameTs, read off the LAYER pool. Non-looping,
// so it is plainly monotonic while playing and jumps on a scrub — either way, equal means a repeat.
export function layerGeneration(layerId: string): number | undefined {
  const ts = layerDecoders.get(layerId)?.dec.lastFrameTs;
  return ts === null || ts === undefined ? undefined : ts;
}

export function releaseLayer(layerId: string): void {
  const cur = layerDecoders.get(layerId);
  if (cur) cur.dec.close();
  layerDecoders.delete(layerId);
}

/**
 * The EXACT frame at a clip-local time, awaited — the non-realtime path (see FileDecoder.frameExact).
 *
 * Rides the LAYER pool rather than the surface or thumbnail pools, and that is the point: a layer
 * decoder is already "a dedicated, non-looping, seekable decoder per key", so an offline render gets
 * its own playhead and cannot re-seek a decoder a live surface or a scrubbing filmstrip is using.
 * Release it through the ordinary releaseLayer().
 *
 * Unlike layerFrame(), this AWAITS the open instead of returning null while it happens: a renderer has
 * nothing useful to do with "not yet", and a null here means "this frame does not exist", which a
 * caller must be able to trust.
 */
export async function layerFrameExact(layerId: string, path: string, timeSec: number): Promise<VideoFrame | null> {
  let cur = layerDecoders.get(layerId);
  if (!cur || cur.path !== path) {
    ensureLayerOpen(layerId, path);
    const opening = layerOpening.get(layerId);
    if (opening) await opening;
    cur = layerDecoders.get(layerId);
  }
  if (!cur || cur.path !== path) { console.warn('[mp4/exact] layer decoder not open for', path); return null; }
  return cur.dec.frameExact(timeSec);
}

/**
 * Native metadata for `path`, from whichever decoder already has the track parsed.
 *
 * Answers from ANY open pool — surface, layer or thumbnail — because the question is about the FILE,
 * not about a playhead, and opening a fourth decoder just to read a header would cost a full copy of
 * the track's samples. Null until something has opened it (a `probe()` is enough); the host treats
 * that as "ask again once it is open" rather than as "unknowable".
 */
export function sourceInfo(path: string): { width: number; height: number; fps: number; durationSec: number } | null {
  // The shared parse first — it exists whenever ANY decoder or a pre-warm holds the file, and it is the
  // full sample table, so its fps is exact even for a fragmented file the index probe cannot count.
  const st = stores.get(path);
  if (st) {
    const sFps = st.samples.length > 1 && st.info.durationSec > 0 ? st.samples.length / st.info.durationSec : 0;
    return sFps > 0 ? { width: st.info.width, height: st.info.height, fps: sFps, durationSec: st.info.durationSec } : null;
  }
  let d: FileDecoder | undefined = decoders.get(path) ?? thumbDecoders.get(path);
  if (!d) for (const v of layerDecoders.values()) if (v.path === path) { d = v.dec; break; }
  const info = d?.getInfo();
  if (!info) {
    // No decoder open: the index probe has the same numbers (its fps is the same sample-count-over-
    // duration formula, read from the moov's sample table). A fragmented file reports fps 0 there and
    // falls through to null — "ask again once it is open", which is what it always meant.
    const ix = indexCache.get(path);
    return ix && ix.fps > 0 ? { width: ix.info.width, height: ix.info.height, fps: ix.fps, durationSec: ix.info.durationSec } : null;
  }
  const fps = d!.fps();
  // A rate we cannot derive is reported as absent rather than as a plausible 30: an export that
  // silently rendered 60p material at 30 would halve its motion with nothing to point at.
  return fps > 0 ? { width: info.width, height: info.height, fps, durationSec: info.durationSec } : null;
}

// Dedicated thumbnail decoder (isolated from the playback decoder above), seekable (non-looping).
export async function thumbnail(path: string, timeSec: number): Promise<VideoFrame | null> {
  let d = thumbDecoders.get(path);
  if (!d) {
    let p = thumbOpening.get(path);
    if (!p) {
      const nd = new FileDecoder();
      p = nd.open(path).then((info) => { if (info) { thumbDecoders.set(path, nd); trimThumbDecoders(); } else nd.close(); thumbOpening.delete(path); return info; });
      thumbOpening.set(path, p);
    }
    await p;
    d = thumbDecoders.get(path);
    if (!d) return null;
  } else {
    // Touch for the LRU: re-inserting moves it to the end of the Map's iteration order, so the file
    // being scrubbed right now is the last one trimThumbDecoders would evict.
    thumbDecoders.delete(path); thumbDecoders.set(path, d);
  }
  // ⚠ THE EXACT FRAME, AWAITED — not frame(). frame() never blocks: on a GOP it has only just fed, it
  // returns null, or the nearest frame it still holds from an EARLIER request. For playback that is the
  // right trade; for a thumbnail it is not, because the caller stores whatever it gets — and stores it
  // on disk beside the project, keyed only by file and time, for good. Measured 2026-10-23: a thumbnail
  // job that ended in 190 ms with nothing stored, so the filmstrip slot kept showing its neighbour.
  // frameExact() drives this decoder's own pump until the frame at `timeSec` is out (it waits for the
  // GOP read, too). This decoder is the thumbnail pool's own, and the pump calling it is serial, so
  // nothing else moves its playhead or evicts it while this waits.
  //
  // Clamped to the last frame: frameExact refuses a time at or past the end ("exact or nothing"), and
  // the last filmstrip slot routinely lands there after time quantization.
  const info = d.getInfo();
  const fps = d.fps() || 30;
  const last = info && info.durationSec > 0 ? Math.max(0, info.durationSec - 1 / fps) : timeSec;
  return d.frameExact(Math.max(0, Math.min(timeSec, last)));
}

// ── MEASUREMENT + FAULT INJECTION (plans/mp4-decoder-freeze.md) ──────────────────────────────────
// A decoder that dies has to be watched across ALL three pools at once: a GPU reset kills every one of
// them in the same instant, and each pool fails differently (a looping surface spins, a layer stalls
// then freezes, a thumbnail freezes). So the stats and the fault hook walk every pool, and the fault
// hook exists so the failure can be produced on demand on any machine — a corrupt frame only trips a
// hardware decoder, and a driver reset cannot be scheduled.
//
// window.__artluxMp4Stats() / __artluxMp4StatsReset() / __artluxMp4Fault(kind, pathPart?) → count hit.
// Same window-guarded pattern as hapDecode's __artluxHapStats.
function allDecoders(): { pool: 'surface' | 'layer' | 'thumb'; key: string; path: string; dec: FileDecoder }[] {
  const out: { pool: 'surface' | 'layer' | 'thumb'; key: string; path: string; dec: FileDecoder }[] = [];
  for (const [path, dec] of decoders) out.push({ pool: 'surface', key: path, path, dec });
  for (const [key, { dec, path }] of layerDecoders) out.push({ pool: 'layer', key, path, dec });
  for (const [path, dec] of thumbDecoders) out.push({ pool: 'thumb', key: path, path, dec });
  return out;
}
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w['__artluxMp4Stats'] = () => allDecoders().map(({ pool, key, path, dec }) => ({
    pool, key: pool === 'layer' ? key : undefined, file: path.split(/[\\/]/).pop(), ...dec.stats(),
  }));
  // The shared parses: one per file however many decoders read it. `holders` = decoders + a pre-warm.
  // `mb` is what the store holds NOW: the GOP cache for a ranged store, the whole track for a whole one.
  w['__artluxMp4Stores'] = () => [...stores.values()].map((s) => ({
    file: s.path.split(/[\\/]/).pop(), mode: s.ranged ? 'ranged' : 'whole', mb: Math.round(s.bytes / 1048576),
    samples: s.samples.length, gops: `${s.ranged ? s.residentGops : s.gopCount}/${s.gopCount}`,
    reads: s.reads, avgReadMs: s.reads ? Math.round(s.readMs / s.reads) : 0,
    holders: s.holders, prewarmed: warmHolds.get(s.path) === s,
  }));
  w['__artluxMp4StatsReset'] = () => {
    for (const { dec } of allDecoders()) { dec.errors = 0; dec.lastError = null; dec.recoveries = 0; dec.feedCapHits = 0; dec.starvedReads = 0; }
  };
  // `pathPart` narrows to decoders whose path contains it; `pool` to one pool. Omitted = every open
  // decoder. The pool filter is not a convenience: faulting two pools at once makes them interact (one
  // pool's stall moves the other's wall-clock playhead far enough to trip its re-seek branch), so the
  // per-pool behaviour can only be observed one pool at a time.
  w['__artluxMp4Fault'] = (kind: Mp4FaultKind, pathPart?: string, pool?: 'surface' | 'layer' | 'thumb'): number => {
    let hit = 0;
    for (const { pool: p, path, dec } of allDecoders()) {
      if (pathPart && !path.includes(pathPart)) continue;
      if (pool && p !== pool) continue;
      if (dec.injectFault(kind)) hit++;
    }
    return hit;
  };
}
