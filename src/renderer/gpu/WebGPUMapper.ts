import { Fixture, Surface, PixelSource, LedShape, RGBWMode } from '../types';
import { IPixelMapper } from '../services/PixelMapper';
import { buildPaletteLut } from './palettes';

// WebGPU compute pixel mapper. Per LED it samples the media source or generates a
// color from an effect + palette (per **segment** of a fixture), converts RGB->RGBW,
// and writes the result; read back asynchronously (mapAsync + staging ring).
//
// Multi-segment: each fixture flattens to 1+ segments (a fixture with no segments
// acts as one implicit segment). Per-LED `ledData.w` is the global segment index;
// `segParams` holds 2x vec4 per segment (+1 trailing "off" entry for gap LEDs).
// Stateful fire2012 uses a persistent `heat` buffer updated by a separate compute
// pass each frame (in-place; races are fine for fire), then mapped through a palette.

const SOURCE_SIZE = 512;      // fallback cell size (uniform-grid fallback + the legacy updateSource path)
const WORKGROUP = 64;
const STAGING_COUNT = 3;
// How often the sampling pass is bracketed with GPU timestamps. ~10 Hz: the number moves slowly, and
// a resolve + copy + map every frame would be a real cost on the very thing being measured.
const GPU_TIMING_INTERVAL_MS = 100;
const FIRE_EFFECT = 4;

// --- Adaptive atlas sizing -----------------------------------------------------------------------
// A surface's atlas cell used to be a fixed 512² square for everyone. That is simultaneously too
// coarse for a dense matrix (a 64-wide matrix on half a surface wants ~256 columns of real detail)
// and pure waste for a 60-LED strip. Sampling is normalized, so cell size/shape is a QUALITY and
// COST decision only — never a correctness one (docs/ARCHITECTURE.md). So: size each cell from the
// LED density actually mapped onto that surface, and pack the differently-sized cells.
const OVERSAMPLE = 2;         // texels per LED along each axis (Nyquist-ish; degraded on overflow)
const MIN_CELL = 64;          // floor — a sparse surface still needs enough to look sane in preview
const MAX_CELL = 1024;        // ceiling per axis, before packing limits apply
const ceilPow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

interface AtlasRect { x: number; y: number; w: number; h: number } // pixels within the atlas

const SHADER = /* wgsl */ `
struct Params { brightness: f32, time: f32, count: u32, paletteCount: u32, frame: u32, p0: u32, p1: u32, p2: u32 };

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> ledData: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outBuf: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var palTex: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> segParams: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read> ledMeta: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> heat: array<f32>;
// Per-surface atlas rect, indexed by surface index: (u0, v0, uSpan, vSpan) in atlas UV, already
// half-texel inset on the CPU. Replaces the old implicit uniform grid — cells now differ in size
// and shape, so the inset has to be computed per rect in ITS OWN texels, not from one constant.
@group(0) @binding(9) var<storage, read> atlasRects: array<vec4<f32>>;

const FIRE: i32 = ${FIRE_EFFECT};

fn toByte(v: f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5); }

fn hashU(x0: u32) -> u32 { var x = x0; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
fn rand01(a: u32, b: u32) -> f32 { return f32(hashU(a * 747796405u + b * 2891336453u + 1u) & 0xffffffu) / 16777216.0; }

fn samplePalette(pid: u32, idx: f32) -> vec4<f32> {
  let u = clamp(fract(idx), 0.0, 0.9999);
  let v = (f32(pid) + 0.5) / f32(params.paletteCount);
  return textureSampleLevel(palTex, samp, vec2<f32>(u, v), 0.0);
}

fn effectColor(eid: i32, t: f32, time: f32, speed: f32, intensity: f32, pid: u32) -> vec4<f32> {
  let sp = speed * 2.0;
  if (eid == 1) {
    return samplePalette(pid, t + time * sp * 0.1);
  } else if (eid == 2) {
    let scale = 0.5 + intensity * 4.0;
    return samplePalette(pid, t * scale + time * sp * 0.15);
  } else if (eid == 3) {
    let c = samplePalette(pid, t);
    let w = 0.5 + 0.5 * sin((t * (1.0 + intensity * 6.0) - time * sp * 0.5) * 6.2831853);
    return vec4<f32>(c.rgb * w, c.a);
  }
  return samplePalette(pid, intensity); // 0 — Solid
}

// Stateful fire2012 — evolves the per-LED heat buffer along each segment.
@compute @workgroup_size(${WORKGROUP})
fn fire(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let segIdx = u32(ledData[i].w + 0.5);
  let fp0 = segParams[2u * segIdx];
  if (fp0.x < 0.0 || i32(fp0.x + 0.5) != FIRE) { return; }
  let intensity = fp0.w;
  let lm = ledMeta[i];
  let segLen = u32(lm.y + 0.5);
  let local = u32(lm.z + 0.5);

  let cooling = 0.015 + (1.0 - intensity) * 0.05;
  var h = heat[i] - rand01(i, params.frame) * cooling;
  if (h < 0.0) { h = 0.0; }
  // propagate from below (cells closer to base); reads prior values in-buffer
  if (local >= 2u) {
    h = (heat[i - 1u] + heat[i - 2u] + h) / 3.0;
  } else if (local == 1u) {
    h = (heat[i - 1u] + h) / 2.0;
  }
  // sparks near the base
  let baseZone = max(1u, segLen / 8u);
  if (local < baseZone) {
    if (rand01(i, params.frame + 7777u) < (0.12 + intensity * 0.4)) {
      let spark = 0.6 + rand01(i, params.frame + 13u) * 0.4;
      if (spark > h) { h = spark; }
    }
  }
  heat[i] = clamp(h, 0.0, 1.0);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }

  // Single atlas pass: every LED samples its OWN surface's cell in the atlas grid
  // (params.p0 cols × params.p1 rows). params.p2 = active surface count; unlinked /
  // out-of-range LEDs go black.
  let surfIdx = u32(ledMeta[i].w + 0.5);
  if (surfIdx >= params.p2) { outBuf[i] = 0u; return; }

  let d = ledData[i];
  let uv = d.xy;
  let t = d.z;
  let segIdx = u32(d.w + 0.5);
  let fp0 = segParams[2u * segIdx];
  let fp1 = segParams[2u * segIdx + 1u];
  let mode = fp0.x; // -2 off, -1 media, >=0 effect id

  if (mode < -1.5) { outBuf[i] = 0u; return; }

  var color: vec4<f32>;
  if (mode < 0.0) {
    // Map this surface's local UV straight into its packed atlas rect. The rect already carries the
    // half-texel inset, so linear filtering still can't reach a neighbouring surface's pixels.
    let r = atlasRects[surfIdx];
    let auv = vec2<f32>(r.x + clamp(uv.x, 0.0, 1.0) * r.z,
                        r.y + clamp(uv.y, 0.0, 1.0) * r.w);
    color = textureSampleLevel(srcTex, samp, auv, 0.0);
  } else if (i32(mode + 0.5) == FIRE) {
    color = samplePalette(u32(fp0.y + 0.5), heat[i]);
  } else {
    color = effectColor(i32(mode + 0.5), t, params.time, fp0.z, fp0.w, u32(fp0.y + 0.5));
  }

  let b = params.brightness;
  var rr: f32; var gg: f32; var bb: f32; var ww: f32;
  if (fp1.x > 0.5) { // RGBWMode.NONE
    rr = color.r * b; gg = color.g * b; bb = color.b * b; ww = 0.0;
  } else {
    let m = min(min(color.r, color.g), color.b);
    rr = (color.r - m) * b; gg = (color.g - m) * b; bb = (color.b - m) * b; ww = m * b;
  }
  outBuf[i] = toByte(rr) | (toByte(gg) << 8u) | (toByte(bb) << 16u) | (toByte(ww) << 24u);
}
`;

interface SegLike { start: number; stop: number; off?: boolean; source?: PixelSource; effectId?: number; paletteId?: number; speed?: number; intensity?: number; }

function fixtureSegments(f: Fixture): SegLike[] {
  if (f.segments && f.segments.length) return f.segments;
  return [{ start: 0, stop: f.ledCount, source: f.source, effectId: f.effectId, paletteId: f.paletteId, speed: f.speed, intensity: f.intensity }];
}

export class WebGPUMapper implements IPixelMapper {
  private device: GPUDevice;
  private queue: GPUQueue;
  private mainPipeline: GPUComputePipeline;
  private firePipeline: GPUComputePipeline;
  private sampler: GPUSampler;
  private srcTexture: GPUTexture;
  private paletteTexture: GPUTexture;
  private paletteCount: number;

  private ledBuffer: GPUBuffer | null = null;
  private metaBuffer: GPUBuffer | null = null;
  private segParamsBuffer: GPUBuffer | null = null;
  private heatBuffer: GPUBuffer | null = null;
  private outBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer;
  private mainBind: GPUBindGroup | null = null;
  private fireBind: GPUBindGroup | null = null;

  private staging: GPUBuffer[] = [];
  private stagingBusy: boolean[] = [];
  private stagingCursor = 0;

  // ── GPU-side timing (optional `timestamp-query` feature) ────────────────────────────────────
  // The app could measure the frame from inside the CPU and nothing else, so "the GPU is behind"
  // and "nothing submitted work to it" were the same reading. These two timestamps bracket the
  // sampling compute pass on the GPU's OWN clock, which is the difference between those two.
  //
  // Sampled at ~10 Hz rather than every frame: a resolve + copy + map round-trip per frame would be
  // a measurable cost on the thing being measured, and this number moves slowly.
  private timestampQuerySet: GPUQuerySet | null = null;
  private timestampResolve: GPUBuffer | null = null;  // QUERY_RESOLVE → COPY_SRC
  private timestampRead: GPUBuffer | null = null;     // COPY_DST → MAP_READ
  private timestampBusy = false;
  private nextTimestampAt = 0;
  /**
   * Last measured pass duration in microseconds. **null means never measured, and that is not the
   * same as 0** — the whole reason this exists is that an unmeasured GPU reported as "0 ms" reads
   * exactly like an idle one. Every consumer must carry the null through rather than default it.
   *
   * 0 is a REAL value here and means "shorter than the timer can resolve" — see readTimestamps.
   */
  private lastComputeUs: number | null = null;
  /** Increments per accepted measurement, so a consumer can tell a new reading from a repeated one. */
  private gpuSeq = 0;
  /** Did this device actually grant `timestamp-query`? Reported honestly; false disables the rest. */
  readonly gpuTimingAvailable: boolean;

  private totalLeds = 0;
  private segCount = 0;
  private brightness = 1.0;
  private startTime = performance.now();
  private frame = 0;
  private latest: Uint8Array | null = null;
  private disposed = false;

  // Strict per-surface sampling (S3).
  readonly perSurface = true;
  private surfaceOrder: string[] = []; // index → surfaceId (also the atlas rect index)
  private atlasRectsPx: AtlasRect[] = []; // packed pixel rect per surface, parallel to surfaceOrder
  private atlasW = SOURCE_SIZE;
  private atlasH = SOURCE_SIZE;
  private atlasRectBuffer: GPUBuffer | null = null; // the vec4 UV rects the shader reads
  private zeroBytes: Uint8Array = new Uint8Array(0);
  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;
  // Reused params staging (one 32-byte uniform block), so the per-surface loop doesn't allocate an
  // ArrayBuffer + DataView per surface per frame.
  private paramScratch = new ArrayBuffer(32);
  private paramScratchView = new DataView(this.paramScratch);

  private constructor(device: GPUDevice, gpuTiming: boolean) {
    this.device = device;
    this.queue = device.queue;
    if (gpuTiming) {
      try {
        this.timestampQuerySet = device.createQuerySet({ type: 'timestamp', count: 2 });
        this.timestampResolve = device.createBuffer({
          size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
        this.timestampRead = device.createBuffer({
          size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      } catch (e) {
        // The feature was granted but the query set would not build. Diagnostics must never be able
        // to stop the mapper, so drop the timing and carry on sampling LEDs.
        console.warn('[WebGPUMapper] timestamp queries unavailable despite the feature:', e);
        this.timestampQuerySet = null;
        this.timestampResolve = null;
        this.timestampRead = null;
      }
    }
    // Derived from what actually got built, never from what was asked for — a flag that says "timing
    // available" over a null query set would put a permanent blank row on the panel with no reason.
    this.gpuTimingAvailable = this.timestampQuerySet !== null;
    this.scratch = document.createElement('canvas');
    this.scratch.width = SOURCE_SIZE; this.scratch.height = SOURCE_SIZE;
    this.scratchCtx = this.scratch.getContext('2d')!;

    const module = device.createShaderModule({ code: SHADER });
    this.mainPipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.firePipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'fire' } });

    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    });

    this.srcTexture = device.createTexture({
      size: [SOURCE_SIZE, SOURCE_SIZE],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const lut = buildPaletteLut();
    this.paletteCount = lut.count;
    this.paletteTexture = device.createTexture({
      size: [lut.width, lut.count],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.queue.writeTexture({ texture: this.paletteTexture }, lut.data, { bytesPerRow: lut.width * 4, rowsPerImage: lut.count }, [lut.width, lut.count]);

    this.paramsBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  static async create(): Promise<WebGPUMapper | null> {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    // Dev/diagnostic force-fallback: return null so Stage takes the WebGL path, to test reduced-mode
    // rendering on machines that DO have WebGPU. Per-machine localStorage flag (Settings ▸ GPU rendering
    // ▸ "Force WebGL fallback") — deliberately NOT a project/prefs field, so it never travels with a show.
    try { if (typeof localStorage !== 'undefined' && localStorage.getItem('artlux.forceWebGL') === '1') return null; } catch { /* ignore */ }
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      // GPU timing is requested ONLY when the adapter advertises it. `requestDevice` REJECTS on an
      // unsupported requiredFeature, so asking unconditionally would take the whole mapper down —
      // and therefore all LED sampling — for the sake of a diagnostic. Ask, then verify on the
      // device: an adapter advertising a feature does not oblige the device to grant it.
      const wantTiming = adapter.features.has('timestamp-query');
      const device = await adapter.requestDevice(wantTiming ? { requiredFeatures: ['timestamp-query'] } : {});
      if (!device) return null;
      const hasTiming = wantTiming && device.features.has('timestamp-query');
      if (!hasTiming) console.log('[WebGPUMapper] no timestamp-query on this device — GPU pass time will read "unavailable", not 0');
      return new WebGPUMapper(device, hasTiming);
    } catch (e) {
      console.warn('[WebGPUMapper] init failed, will fall back', e);
      return null;
    }
  }

  setBrightness(value: number): void {
    this.brightness = Math.max(0, Math.min(1, value));
  }

  // Build the segParams buffer contents: 2x vec4 per segment + 1 trailing "off" entry.
  private buildSegParams(fixtures: Fixture[]): Float32Array {
    const segs: { s: SegLike; f: Fixture }[] = [];
    for (const f of fixtures) for (const s of fixtureSegments(f)) segs.push({ s, f });
    const out = new Float32Array((segs.length + 1) * 8);
    segs.forEach(({ s, f }, k) => {
      const base = k * 8;
      // S3: every fixture samples its linked surface's texture (media). Per-fixture
      // effects are retired — effects live on surfaces now. An off segment outputs black:
      // mode -2 is already the WGSL "off" path (mode < -1.5), same as the trailing gap entry.
      out[base + 0] = s.off ? -2 : -1; // -2 off (gap) / -1 media
      out[base + 4] = f.rgbwMode === RGBWMode.NONE ? 1 : 0;
    });
    // trailing off-segment for gap LEDs
    out[segs.length * 8 + 0] = -2;
    return out;
  }

  private countSegments(fixtures: Fixture[]): number {
    let n = 0;
    for (const f of fixtures) n += fixtureSegments(f).length;
    return n;
  }

  // How many texels each surface's cell wants, from the LED density mapped onto it. A fixture whose
  // 32 LEDs span half the surface implies the FULL surface needs ~64 columns to resolve them, so the
  // LED count is divided by the fraction of the surface the fixture covers. Max over its fixtures.
  private cellSizes(fixtures: Fixture[], surfaces: Surface[], oversample: number): { w: number; h: number }[] {
    return this.surfaceOrder.map((sid) => {
      const s = surfaces.find((x) => x.id === sid);
      const sw = Math.max(1e-6, s?.width ?? 1);
      const sh = Math.max(1e-6, s?.height ?? 1);
      let needU = 0, needV = 0;
      for (const f of fixtures) {
        if (f.surfaceId !== sid) continue;
        let lu: number, lv: number;
        if (f.shape === LedShape.MATRIX) {
          lu = Math.max(1, f.matrixWidth ?? 1);
          lv = Math.max(1, f.matrixHeight ?? 1);
        } else if (f.width >= f.height) { lu = Math.max(1, f.ledCount); lv = 1; }
        else { lu = 1; lv = Math.max(1, f.ledCount); }
        // A rotated fixture's chain runs across BOTH surface axes; without an exact projection just
        // demand the larger count on each axis rather than under-resolving the diagonal.
        const rot = Math.abs((f.rotation || 0) % 180);
        if (rot > 1 && rot < 179) { const m = Math.max(lu, lv); lu = m; lv = m; }
        // Fraction of the surface this fixture covers, capped at 1 so a fixture larger than its
        // surface can't *reduce* the demand.
        const fu = Math.min(1, Math.max(1e-3, (f.width || 0) / sw));
        const fv = Math.min(1, Math.max(1e-3, (f.height || 0) / sh));
        needU = Math.max(needU, lu / fu);
        needV = Math.max(needV, lv / fv);
      }
      const clamp = (n: number): number => Math.min(MAX_CELL, Math.max(MIN_CELL, ceilPow2(n * oversample)));
      // No linked fixture shouldn't happen (surfaceOrder is filtered to linked surfaces) but a
      // surface can be re-linked live, so it still gets a usable cell rather than a zero-sized one.
      return { w: clamp(needU || MIN_CELL), h: clamp(needV || MIN_CELL) };
    });
  }

  // Shelf packer: sort by height desc, fill rows left→right, start a new shelf when the row is full.
  // Deterministic and more than good enough for the handful of surfaces a show has. Returns null if
  // the result won't fit the device's max texture dimension.
  private packAtlas(sizes: { w: number; h: number }[], maxDim: number): { rects: AtlasRect[]; w: number; h: number } | null {
    if (!sizes.length) return { rects: [], w: 1, h: 1 };
    const area = sizes.reduce((a, s) => a + s.w * s.h, 0);
    const widest = sizes.reduce((a, s) => Math.max(a, s.w), 0);
    if (widest > maxDim) return null;
    // Start near-square, grow the shelf width until the stack fits (or we run out of texture).
    for (let width = Math.min(maxDim, Math.max(widest, ceilPow2(Math.sqrt(area)))); width <= maxDim; width *= 2) {
      const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h);
      const rects: AtlasRect[] = new Array(sizes.length);
      let x = 0, y = 0, shelfH = 0, ok = true;
      for (const i of order) {
        const { w, h } = sizes[i];
        if (x + w > width) { x = 0; y += shelfH; shelfH = 0; }   // next shelf
        if (y + h > maxDim) { ok = false; break; }
        rects[i] = { x, y, w, h };
        x += w;
        if (h > shelfH) shelfH = h;
      }
      // Round the stack height up to a power of two, but never past the device limit (maxDim is 8192
      // — a power of two — on every device seen so far, but don't bet the texture creation on it).
      if (ok) return { rects, w: width, h: Math.min(maxDim, ceilPow2(y + shelfH)) };
      if (width === maxDim) break;
    }
    return null;
  }

  updateMapping(fixtures: Fixture[], surfaces: Surface[] = []): void {
    if (this.disposed) return;
    const newTotal = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
    this.totalLeds = newTotal;
    this.segCount = this.countSegments(fixtures);
    // Surfaces referenced by ≥1 fixture, in surface order. The pass index for a
    // surface is its position here; LEDs store this index in ledMeta.w.
    this.surfaceOrder = surfaces.filter(s => fixtures.some(f => f.surfaceId === s.id)).map(s => s.id);
    const OFF = 65535; // unlinked LEDs — never matched by a pass, left black
    if (newTotal === 0) return;

    const led = new Float32Array(newTotal * 4);   // (u, v, t, segIndex)
    const meta = new Float32Array(newTotal * 4);  // (segStartGlobal, segLen, localIndex, 0)
    let o = 0, m = 0;
    let ledBase = 0;   // global LED index of this fixture's first LED
    let segCursor = 0; // global segment index of this fixture's first segment
    const offSeg = this.segCount;

    fixtures.forEach((f) => {
      const segs = fixtureSegments(f);
      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      const rads = (f.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rads), sin = Math.sin(rads);

      // Linked surface → inverse transform a global point into surface-local UV.
      const surf = surfaces.find(s => s.id === f.surfaceId) || null;
      const sIdx = surf ? this.surfaceOrder.indexOf(surf.id) : OFF;
      const scx = surf ? surf.x + surf.width / 2 : 0;
      const scy = surf ? surf.y + surf.height / 2 : 0;
      const sr = surf ? -(surf.rotation || 0) * (Math.PI / 180) : 0;
      const scos = Math.cos(sr), ssin = Math.sin(sr);
      const sw = surf ? (surf.width || 1) : 1;
      const sh = surf ? (surf.height || 1) : 1;
      const isMatrix = f.shape === LedShape.MATRIX;
      const cols = Math.max(1, f.matrixWidth ?? 1);
      const rows = Math.max(1, f.matrixHeight ?? 1);
      const cells = cols * rows;
      const isHoriz = f.width >= f.height;

      for (let i = 0; i < f.ledCount; i++) {
        // which segment contains output index i
        let j = -1;
        for (let q = 0; q < segs.length; q++) { if (i >= segs[q].start && i < segs[q].stop) { j = q; break; } }
        let segIndex: number, segStartGlobal: number, segLen: number, local: number, tt: number;
        if (j < 0) {
          segIndex = offSeg; segStartGlobal = 0; segLen = 0; local = 0; tt = 0;
        } else {
          const s = segs[j];
          segIndex = segCursor + j;
          segStartGlobal = ledBase + s.start;
          segLen = s.stop - s.start;
          local = i - s.start;
          tt = segLen > 1 ? local / (segLen - 1) : 0;
          if (f.reverse) tt = 1 - tt;
        }

        // geometry (uv) from the geometry index g (reverse- + ledmap-aware).
        // Reverse flips the whole fixture's pixel order so output index i samples
        // the geometry of the opposite end (matches led3dLayout's local.reverse()).
        const gi = f.reverse ? f.ledCount - 1 - i : i;
        const g = f.ledMap ? (f.ledMap[gi] ?? gi) : gi;
        let relX = 0, relY = 0;
        if (isMatrix) {
          const gg = Math.min(g, cells - 1);
          const row = Math.floor(gg / cols);
          let col = gg % cols;
          if (f.serpentine && row % 2 === 1) col = cols - 1 - col;
          relX = (col + 0.5) * (f.width / cols) - f.width / 2;
          relY = (row + 0.5) * (f.height / rows) - f.height / 2;
        } else if (isHoriz) {
          const step = f.width / f.ledCount;
          relX = g * step + step / 2 - f.width / 2;
        } else {
          const step = f.height / f.ledCount;
          relY = g * step + step / 2 - f.height / 2;
        }
        const rx = relX * cos - relY * sin;
        const ry = relX * sin + relY * cos;
        const gx = cx + rx, gy = cy + ry;

        // Surface-local UV (clamped sampler handles out-of-range); falls back to
        // the global point when unlinked (those LEDs are off / cleared anyway).
        let uu = gx, vv = gy;
        if (surf) {
          const ddx = gx - scx, ddy = gy - scy;
          const lx = ddx * scos - ddy * ssin;
          const ly = ddx * ssin + ddy * scos;
          uu = lx / sw + 0.5; vv = ly / sh + 0.5;
        }

        led[o++] = uu; led[o++] = vv; led[o++] = tt; led[o++] = segIndex;
        meta[m++] = segStartGlobal; meta[m++] = segLen; meta[m++] = local; meta[m++] = sIdx;
      }
      ledBase += f.ledCount;
      segCursor += segs.length;
    });

    const segData = this.buildSegParams(fixtures);

    this.ledBuffer?.destroy();
    this.ledBuffer = this.device.createBuffer({ size: led.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.queue.writeBuffer(this.ledBuffer, 0, led);

    this.metaBuffer?.destroy();
    this.metaBuffer = this.device.createBuffer({ size: meta.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.queue.writeBuffer(this.metaBuffer, 0, meta);

    this.segParamsBuffer?.destroy();
    this.segParamsBuffer = this.device.createBuffer({ size: Math.max(32, segData.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.queue.writeBuffer(this.segParamsBuffer, 0, segData);

    this.heatBuffer?.destroy();
    this.heatBuffer = this.device.createBuffer({ size: newTotal * 4, usage: GPUBufferUsage.STORAGE }); // zero-initialized

    const outBytes = newTotal * 4;
    this.outBuffer?.destroy();
    this.outBuffer = this.device.createBuffer({ size: outBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.zeroBytes = new Uint8Array(outBytes); // cleared into outBuf each frame

    for (const s of this.staging) s.destroy();
    this.staging = []; this.stagingBusy = [];
    for (let i = 0; i < STAGING_COUNT; i++) {
      this.staging.push(this.device.createBuffer({ size: outBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
      this.stagingBusy.push(false);
    }
    this.stagingCursor = 0;
    this.latest = new Uint8Array(outBytes);

    // Size each surface's cell from its LED density, pack the cells, and resize the source texture +
    // scratch canvas to the packed atlas. One upload of this atlas still replaces the old
    // per-surface uploads (the dominant stall under projector contention) — only the layout changed.
    const maxDim = this.device.limits.maxTextureDimension2D;
    let packed: { rects: AtlasRect[]; w: number; h: number } | null = null;
    let usedOversample = OVERSAMPLE;
    // Degrade rather than fail: halve the oversample, then fall back to minimum cells. Each step is
    // announced — a silently coarser atlas would surface later as a mystery quality regression.
    for (const os of [OVERSAMPLE, OVERSAMPLE / 2, OVERSAMPLE / 4]) {
      packed = this.packAtlas(this.cellSizes(fixtures, surfaces, os), maxDim);
      if (packed) { usedOversample = os; break; }
    }
    if (!packed) {
      packed = this.packAtlas(this.surfaceOrder.map(() => ({ w: MIN_CELL, h: MIN_CELL })), maxDim);
      usedOversample = 0;
    }
    if (!packed) {
      console.warn(`[WebGPUMapper] ${this.surfaceOrder.length} surfaces cannot be packed into a ${maxDim}² atlas — sampling disabled for the overflow.`);
      packed = { rects: [], w: 1, h: 1 };
    } else if (usedOversample < OVERSAMPLE) {
      console.warn(`[WebGPUMapper] atlas oversample reduced to ${usedOversample}× (${this.surfaceOrder.length} surfaces, ${maxDim}² limit) — LED sampling is coarser than requested.`);
    }

    this.atlasRectsPx = packed.rects;
    if (packed.w !== this.atlasW || packed.h !== this.atlasH) {
      this.atlasW = packed.w; this.atlasH = packed.h;
      this.srcTexture.destroy();
      this.srcTexture = this.device.createTexture({
        size: [this.atlasW, this.atlasH],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.scratch.width = this.atlasW;
      this.scratch.height = this.atlasH;
    }

    // UV rects for the shader, half-texel inset inside each rect's OWN pixels so linear filtering
    // can never reach the neighbouring surface packed beside it.
    const rectData = new Float32Array(Math.max(1, this.atlasRectsPx.length) * 4);
    this.atlasRectsPx.forEach((r, i) => {
      rectData[i * 4 + 0] = (r.x + 0.5) / this.atlasW;
      rectData[i * 4 + 1] = (r.y + 0.5) / this.atlasH;
      rectData[i * 4 + 2] = Math.max(0, r.w - 1) / this.atlasW;
      rectData[i * 4 + 3] = Math.max(0, r.h - 1) / this.atlasH;
    });
    this.atlasRectBuffer?.destroy();
    this.atlasRectBuffer = this.device.createBuffer({ size: rectData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.queue.writeBuffer(this.atlasRectBuffer, 0, rectData);

    this.mainBind = this.device.createBindGroup({
      layout: this.mainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.srcTexture.createView() },
        { binding: 2, resource: { buffer: this.ledBuffer } },
        { binding: 3, resource: { buffer: this.outBuffer } },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
        { binding: 5, resource: this.paletteTexture.createView() },
        { binding: 6, resource: { buffer: this.segParamsBuffer } },
        { binding: 7, resource: { buffer: this.metaBuffer } },
        { binding: 8, resource: { buffer: this.heatBuffer } },
        { binding: 9, resource: { buffer: this.atlasRectBuffer } },
      ],
    });
    this.fireBind = this.device.createBindGroup({
      layout: this.firePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 2, resource: { buffer: this.ledBuffer } },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
        { binding: 6, resource: { buffer: this.segParamsBuffer } },
        { binding: 7, resource: { buffer: this.metaBuffer } },
        { binding: 8, resource: { buffer: this.heatBuffer } },
      ],
    });
  }

  // Cheap path: only segment effect params changed (same segment structure).
  updateParams(fixtures: Fixture[]): void {
    if (this.disposed || !this.segParamsBuffer) return;
    if (this.countSegments(fixtures) !== this.segCount) return; // structure change -> updateMapping
    this.queue.writeBuffer(this.segParamsBuffer, 0, this.buildSegParams(fixtures));
  }

  updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): void {
    if (this.disposed) return;
    try {
      // Legacy whole-texture path (perSurface is true, so Stage never takes this branch for WebGPU).
      this.queue.copyExternalImageToTexture({ source: source as GPUCopyExternalImageSource, flipY: false }, { texture: this.srcTexture }, [this.atlasW, this.atlasH]);
    } catch { /* source not ready */ }
  }

  // Atlas render: compose every surface's drawable into one atlas canvas (each into its own packed
  // rect, sized to that surface's LED density), upload it in a SINGLE copyExternalImageToTexture,
  // then run ONE compute pass where each LED samples its own rect. This collapses the N per-surface
  // texture uploads — each a fixed GPU-process sync stall that dominates under projector
  // contention — down to one upload + one submit.
  renderSurfaces(getDrawable: (surfaceId: string) => CanvasImageSource | null, getOpacity?: (surfaceId: string) => number): void {
    if (this.disposed || this.totalLeds === 0 || !this.mainBind || !this.outBuffer) return;

    // Clear last frame's output so unlinked LEDs (and removed surfaces) go black.
    this.queue.writeBuffer(this.outBuffer, 0, this.zeroBytes);

    this.frame = (this.frame + 1) >>> 0;
    const time = (performance.now() - this.startTime) / 1000;
    const groups = Math.ceil(this.totalLeds / WORKGROUP);

    // Compose the atlas: black background (unpacked gaps + fade-to-black), then each surface's
    // drawable stretched into its rect. Opacity blends toward black (shader samples RGB, ignores A).
    this.scratchCtx.globalAlpha = 1;
    this.scratchCtx.fillStyle = '#000';
    this.scratchCtx.fillRect(0, 0, this.scratch.width, this.scratch.height);
    for (let k = 0; k < this.surfaceOrder.length; k++) {
      const r = this.atlasRectsPx[k];
      if (!r) continue; // overflowed the atlas (already warned) — leave it black
      const d = getDrawable(this.surfaceOrder[k]);
      if (!d) continue;
      const opacity = getOpacity ? getOpacity(this.surfaceOrder[k]) : 1;
      if (opacity <= 0) continue; // fully transparent → leave the rect black
      try {
        this.scratchCtx.globalAlpha = opacity < 1 ? opacity : 1;
        this.scratchCtx.drawImage(d, r.x, r.y, r.w, r.h);
      } catch { /* skip this surface's rect for this frame */ }
    }
    this.scratchCtx.globalAlpha = 1;
    try {
      this.queue.copyExternalImageToTexture(
        { source: this.scratch, flipY: false },
        { texture: this.srcTexture },
        [this.scratch.width, this.scratch.height]);
    } catch { /* atlas source not ready this frame */ }

    // Params written once. p0/p1 used to carry the atlas grid; the shader now reads an explicit
    // per-surface rect from atlasRects, so they are unused (kept zeroed rather than renumbering the
    // uniform block). p2 is still the surface count — the unlinked-LED guard.
    const dv = this.paramScratchView;
    dv.setFloat32(0, this.brightness, true);
    dv.setFloat32(4, time, true);
    dv.setUint32(8, this.totalLeds, true);
    dv.setUint32(12, this.paletteCount, true);
    dv.setUint32(16, this.frame, true);
    dv.setUint32(20, 0, true);                        // p0 — unused (was atlas cols)
    dv.setUint32(24, 0, true);                        // p1 — unused (was atlas rows)
    dv.setUint32(28, this.surfaceOrder.length, true); // p2 = surface count
    this.queue.writeBuffer(this.paramsBuffer, 0, this.paramScratch);

    const enc = this.device.createCommandEncoder();
    // Bracket the pass with GPU timestamps when one is due and the previous read has landed. Skipping
    // is always safe: the reported value simply stays at the last measurement rather than becoming 0.
    const nowMs = performance.now();
    const timing = this.timestampQuerySet !== null && !this.timestampBusy && nowMs >= this.nextTimestampAt;
    const mp = enc.beginComputePass(timing
      ? { timestampWrites: { querySet: this.timestampQuerySet!, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
      : {});
    mp.setPipeline(this.mainPipeline);
    mp.setBindGroup(0, this.mainBind);
    mp.dispatchWorkgroups(groups);
    mp.end();
    if (timing) {
      enc.resolveQuerySet(this.timestampQuerySet!, 0, 2, this.timestampResolve!, 0);
      enc.copyBufferToBuffer(this.timestampResolve!, 0, this.timestampRead!, 0, 16);
    }
    this.queue.submit([enc.finish()]);
    if (timing) {
      this.timestampBusy = true;
      this.nextTimestampAt = nowMs + GPU_TIMING_INTERVAL_MS;
      this.readTimestamps();
    }

    const idx = this.findFreeStaging();
    if (idx === -1) return;
    const enc2 = this.device.createCommandEncoder();
    enc2.copyBufferToBuffer(this.outBuffer, 0, this.staging[idx], 0, this.totalLeds * 4);
    this.queue.submit([enc2.finish()]);
    this.stagingBusy[idx] = true;
    const buf = this.staging[idx];
    buf.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      const copy = new Uint8Array(buf.getMappedRange());
      if (this.latest && this.latest.length === copy.length) this.latest.set(copy);
      buf.unmap();
      this.stagingBusy[idx] = false;
    }).catch(() => { this.stagingBusy[idx] = false; });
  }

  read(): Uint8Array | null {
    return this.latest && this.totalLeds > 0 ? this.latest : null;
  }

  /**
   * How long the GPU spent on the last timed sampling pass — measured on the GPU's own clock, not
   * inferred from the CPU.
   *
   * **null means no measurement**, either because the device has no `timestamp-query` or because
   * none has resolved yet. Callers must not coalesce that to 0: a GPU that was never timed and a
   * GPU that did nothing are the two readings this whole feature exists to tell apart.
   *
   * `seq` increments once per accepted measurement. Consumers must de-duplicate on it rather than on
   * the value, because `us: 0` is a legitimate repeated reading (see below) and de-duplicating by
   * value would silently drop every one after the first.
   */
  gpuSample(): { us: number; seq: number } | null {
    return this.lastComputeUs === null ? null : { us: this.lastComputeUs, seq: this.gpuSeq };
  }

  /**
   * Map the resolved pair back and turn it into a duration. One buffer, one in-flight read, guarded
   * by `timestampBusy` — mapping a buffer that is already mapped is a validation error, and at 10 Hz
   * a ring would be machinery for nothing.
   *
   * ⚠ THE CLOCK IS QUANTIZED, AND THAT NEARLY MADE THIS FEATURE REPORT NOTHING AT ALL. Chrome rounds
   * timestamp-query results to a coarse grid to blunt timing attacks — measured on this machine at
   * **65,536 ns (2^16), i.e. ~65.5 µs**, with every raw timestamp an exact multiple of it. So a pass
   * quicker than one quantum resolves with `begin == end` and a delta of exactly **0**.
   *
   * The first version of this guard read `if (end > begin)`, which threw those away and left the
   * whole feature silent on the very machines where the answer is "the GPU is not the problem".
   * "Faster than the timer can see" and "no measurement" are different facts and are distinguished
   * HERE, once: an unresolved query leaves the timestamps at 0, so `begin > 0` is the liveness test
   * and a zero delta afterwards is a real reading meaning *under ~65 µs*.
   */
  private readTimestamps(): void {
    const buf = this.timestampRead;
    if (!buf) { this.timestampBusy = false; return; }
    buf.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      try {
        const pair = new BigUint64Array(buf.getMappedRange());
        const begin = pair[0], end = pair[1];
        buf.unmap();
        if (begin > 0n && end >= begin) {
          this.lastComputeUs = Number(end - begin) / 1000;
          this.gpuSeq++;
        }
      } finally {
        this.timestampBusy = false;
      }
    }).catch(() => { this.timestampBusy = false; });
  }

  private findFreeStaging(): number {
    for (let n = 0; n < this.staging.length; n++) {
      const i = (this.stagingCursor + n) % this.staging.length;
      if (!this.stagingBusy[i]) { this.stagingCursor = (i + 1) % this.staging.length; return i; }
    }
    return -1;
  }

  dispose(): void {
    this.disposed = true;
    this.ledBuffer?.destroy();
    this.metaBuffer?.destroy();
    this.segParamsBuffer?.destroy();
    this.heatBuffer?.destroy();
    this.outBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.atlasRectBuffer?.destroy();
    this.srcTexture?.destroy();
    this.paletteTexture?.destroy();
    for (const s of this.staging) { try { s.destroy(); } catch { /* mapped */ } }
    this.staging = [];
    // `disposed` is already true, so an in-flight mapAsync resolves into a no-op before touching
    // these — destroying a buffer with a pending map is the one ordering that would throw here.
    try { this.timestampQuerySet?.destroy(); } catch { /* already gone */ }
    try { this.timestampResolve?.destroy(); } catch { /* already gone */ }
    try { this.timestampRead?.destroy(); } catch { /* mapped */ }
    this.timestampQuerySet = null;
    this.timestampResolve = null;
    this.timestampRead = null;
    this.latest = null;
    this.device.destroy();
  }
}
