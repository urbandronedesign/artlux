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

const SOURCE_SIZE = 512;
const WORKGROUP = 64;
const STAGING_COUNT = 3;
const FIRE_EFFECT = 4;

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

  // Per-surface pass: only LEDs linked to params.p0 (the active surface) are
  // written this pass; others are left untouched (outBuf is cleared each frame).
  let surfIdx = u32(ledMeta[i].w + 0.5);
  if (surfIdx != params.p0) { return; }

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
    color = textureSampleLevel(srcTex, samp, uv, 0.0);
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

interface SegLike { start: number; stop: number; source?: PixelSource; effectId?: number; paletteId?: number; speed?: number; intensity?: number; }

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

  private totalLeds = 0;
  private segCount = 0;
  private brightness = 1.0;
  private startTime = performance.now();
  private frame = 0;
  private latest: Uint8Array | null = null;
  private disposed = false;

  // Strict per-surface sampling (S3).
  readonly perSurface = true;
  private surfaceOrder: string[] = []; // index → surfaceId (the active-surface id per pass)
  private zeroBytes: Uint8Array = new Uint8Array(0);
  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;

  private constructor(device: GPUDevice) {
    this.device = device;
    this.queue = device.queue;
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
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      if (!device) return null;
      return new WebGPUMapper(device);
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
      // effects are retired — effects live on surfaces now.
      void s;
      out[base + 0] = -1; // media
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
      this.queue.copyExternalImageToTexture({ source: source as GPUCopyExternalImageSource, flipY: false }, { texture: this.srcTexture }, [SOURCE_SIZE, SOURCE_SIZE]);
    } catch { /* source not ready */ }
  }

  // Strict per-surface render: one compute pass per surface, each binding that
  // surface's drawable and writing only its LEDs (gated by ledMeta.w). One readback.
  renderSurfaces(getDrawable: (surfaceId: string) => CanvasImageSource | null): void {
    if (this.disposed || this.totalLeds === 0 || !this.mainBind || !this.outBuffer) return;

    // Clear last frame's output so unlinked LEDs (and removed surfaces) go black.
    this.queue.writeBuffer(this.outBuffer, 0, this.zeroBytes);

    this.frame = (this.frame + 1) >>> 0;
    const time = (performance.now() - this.startTime) / 1000;
    const groups = Math.ceil(this.totalLeds / WORKGROUP);

    for (let k = 0; k < this.surfaceOrder.length; k++) {
      const d = getDrawable(this.surfaceOrder[k]);
      if (!d) continue;
      // Stretch the surface's drawable into the 512² source texture.
      try {
        this.scratchCtx.clearRect(0, 0, SOURCE_SIZE, SOURCE_SIZE);
        this.scratchCtx.drawImage(d, 0, 0, SOURCE_SIZE, SOURCE_SIZE);
        this.queue.copyExternalImageToTexture({ source: this.scratch, flipY: false }, { texture: this.srcTexture }, [SOURCE_SIZE, SOURCE_SIZE]);
      } catch { continue; }

      const params = new ArrayBuffer(32);
      const dv = new DataView(params);
      dv.setFloat32(0, this.brightness, true);
      dv.setFloat32(4, time, true);
      dv.setUint32(8, this.totalLeds, true);
      dv.setUint32(12, this.paletteCount, true);
      dv.setUint32(16, this.frame, true);
      dv.setUint32(20, k, true); // params.p0 = active surface
      this.queue.writeBuffer(this.paramsBuffer, 0, params);

      const enc = this.device.createCommandEncoder();
      const mp = enc.beginComputePass();
      mp.setPipeline(this.mainPipeline);
      mp.setBindGroup(0, this.mainBind);
      mp.dispatchWorkgroups(groups);
      mp.end();
      this.queue.submit([enc.finish()]);
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
    this.srcTexture?.destroy();
    this.paletteTexture?.destroy();
    for (const s of this.staging) { try { s.destroy(); } catch { /* mapped */ } }
    this.staging = [];
    this.latest = null;
    this.device.destroy();
  }
}
