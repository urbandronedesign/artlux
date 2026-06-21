import { Fixture, PixelSource, LedShape, RGBWMode } from '../types';
import { IPixelMapper } from '../services/PixelMapper';
import { buildPaletteLut } from './palettes';

// WebGPU compute-based pixel mapper. Drop-in for the WebGL GPUMapper. Per LED it
// either samples the media source at the LED's UV, or generates a color from a
// built-in effect + palette (WLED-style), then converts RGB->RGBW (subtract-min,
// parity with the WebGL shader) on the GPU. Output is read back asynchronously
// (mapAsync + a staging-buffer ring) to avoid the synchronous readPixels stall.
//
// Per-LED static layout (uv, strip position t, fixture index) lives in `ledData`;
// per-fixture dynamic effect params live in `fixParams` so slider tweaks only
// rewrite a tiny buffer instead of reallocating.

const SOURCE_SIZE = 512;
const WORKGROUP = 64;
const STAGING_COUNT = 3;

const SHADER = /* wgsl */ `
struct Params { brightness: f32, time: f32, count: u32, paletteCount: u32 };

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> ledData: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> outBuf: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;
@group(0) @binding(5) var palTex: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> fixParams: array<vec4<f32>>;

fn toByte(v: f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5); }

fn samplePalette(pid: u32, idx: f32) -> vec4<f32> {
  let u = clamp(fract(idx), 0.0, 0.9999);
  let v = (f32(pid) + 0.5) / f32(params.paletteCount);
  return textureSampleLevel(palTex, samp, vec2<f32>(u, v), 0.0);
}

fn effectColor(eid: i32, t: f32, time: f32, speed: f32, intensity: f32, pid: u32) -> vec4<f32> {
  let sp = speed * 2.0;
  if (eid == 1) {            // Rainbow — palette swept along strip, scrolling
    return samplePalette(pid, t + time * sp * 0.1);
  } else if (eid == 2) {     // Palette Flow — scaled by intensity, scrolling
    let scale = 0.5 + intensity * 4.0;
    return samplePalette(pid, t * scale + time * sp * 0.15);
  } else if (eid == 3) {     // Wave — travelling brightness sine over palette
    let c = samplePalette(pid, t);
    let w = 0.5 + 0.5 * sin((t * (1.0 + intensity * 6.0) - time * sp * 0.5) * 6.2831853);
    return vec4<f32>(c.rgb * w, c.a);
  }
  return samplePalette(pid, intensity); // 0 — Solid
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }

  let d = ledData[i];
  let uv = d.xy;
  let t = d.z;
  let fi = u32(d.w + 0.5);
  let fp0 = fixParams[2u * fi];        // effectOrMedia, paletteId, speed, intensity
  let fp1 = fixParams[2u * fi + 1u];   // rgbwMode, ...
  let mode = fp0.x; // < 0 => media, else effect id

  var color: vec4<f32>;
  if (mode < 0.0) {
    color = textureSampleLevel(srcTex, samp, uv, 0.0);
  } else {
    color = effectColor(i32(mode + 0.5), t, params.time, fp0.z, fp0.w, u32(fp0.y + 0.5));
  }

  let b = params.brightness;
  var rr: f32; var gg: f32; var bb: f32; var ww: f32;
  if (fp1.x > 0.5) {        // RGBWMode.NONE -> full RGB, no white
    rr = color.r * b; gg = color.g * b; bb = color.b * b; ww = 0.0;
  } else {                  // RGBWMode.SUBTRACT (default)
    let m = min(min(color.r, color.g), color.b);
    rr = (color.r - m) * b; gg = (color.g - m) * b; bb = (color.b - m) * b; ww = m * b;
  }
  outBuf[i] = toByte(rr) | (toByte(gg) << 8u) | (toByte(bb) << 16u) | (toByte(ww) << 24u);
}
`;

export class WebGPUMapper implements IPixelMapper {
  private device: GPUDevice;
  private queue: GPUQueue;
  private pipeline: GPUComputePipeline;
  private sampler: GPUSampler;
  private srcTexture: GPUTexture;
  private paletteTexture: GPUTexture;
  private paletteCount: number;

  private mapBuffer: GPUBuffer | null = null;
  private fixParamsBuffer: GPUBuffer | null = null;
  private outBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup | null = null;

  private staging: GPUBuffer[] = [];
  private stagingBusy: boolean[] = [];
  private stagingCursor = 0;

  private totalLeds = 0;
  private fixCount = 0;
  private brightness = 1.0;
  private startTime = performance.now();
  private latest: Uint8Array | null = null;
  private disposed = false;

  private constructor(device: GPUDevice) {
    this.device = device;
    this.queue = device.queue;

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });

    this.sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    this.srcTexture = device.createTexture({
      size: [SOURCE_SIZE, SOURCE_SIZE],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Palette LUT (256 x paletteCount).
    const lut = buildPaletteLut();
    this.paletteCount = lut.count;
    this.paletteTexture = device.createTexture({
      size: [lut.width, lut.count],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.queue.writeTexture(
      { texture: this.paletteTexture },
      lut.data,
      { bytesPerRow: lut.width * 4, rowsPerImage: lut.count },
      [lut.width, lut.count],
    );

    this.paramsBuffer = device.createBuffer({
      size: 16, // brightness(f32) + time(f32) + count(u32) + paletteCount(u32)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
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

  // Two vec4 per fixture: [effectOrMedia, paletteId, speed, intensity], [rgbwMode,...]
  private fixtureParamVec(f: Fixture, out: Float32Array, k: number): void {
    const base = k * 8;
    const isEffect = f.source === PixelSource.EFFECT;
    out[base + 0] = isEffect ? (f.effectId ?? 0) : -1;
    out[base + 1] = f.paletteId ?? 0;
    out[base + 2] = f.speed ?? 0.5;
    out[base + 3] = f.intensity ?? 0.5;
    out[base + 4] = f.rgbwMode === RGBWMode.NONE ? 1 : 0;
    out[base + 5] = 0;
    out[base + 6] = 0;
    out[base + 7] = 0;
  }

  updateMapping(fixtures: Fixture[]): void {
    if (this.disposed) return;
    const newTotal = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
    this.totalLeds = newTotal;
    this.fixCount = fixtures.length;
    if (newTotal === 0) return;

    const led = new Float32Array(newTotal * 4);   // (u, v, t, fixtureIndex)
    const fix = new Float32Array(fixtures.length * 8); // 2 vec4 per fixture
    let o = 0;

    fixtures.forEach((f, k) => {
      this.fixtureParamVec(f, fix, k);

      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      const rads = (f.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rads);
      const sin = Math.sin(rads);
      const isMatrix = f.shape === LedShape.MATRIX;
      const cols = Math.max(1, f.matrixWidth ?? 1);
      const rows = Math.max(1, f.matrixHeight ?? 1);
      const cells = cols * rows;
      const isHoriz = f.width >= f.height;

      for (let i = 0; i < f.ledCount; i++) {
        // ledmap: physical output index i -> geometry index g
        const g = f.ledMap ? (f.ledMap[i] ?? i) : i;

        let relX = 0, relY = 0;
        let t: number;
        if (isMatrix) {
          const gg = Math.min(g, cells - 1);
          const row = Math.floor(gg / cols);
          let col = gg % cols;
          if (f.serpentine && row % 2 === 1) col = cols - 1 - col;
          const cellW = f.width / cols;
          const cellH = f.height / rows;
          relX = (col + 0.5) * cellW - f.width / 2;
          relY = (row + 0.5) * cellH - f.height / 2;
          t = cells > 1 ? gg / (cells - 1) : 0;
        } else if (isHoriz) {
          const step = f.width / f.ledCount;
          relX = g * step + step / 2 - f.width / 2;
          t = f.ledCount > 1 ? g / (f.ledCount - 1) : 0;
        } else {
          const step = f.height / f.ledCount;
          relY = g * step + step / 2 - f.height / 2;
          t = f.ledCount > 1 ? g / (f.ledCount - 1) : 0;
        }
        if (f.reverse) t = 1 - t;

        const rx = relX * cos - relY * sin;
        const ry = relX * sin + relY * cos;
        led[o++] = cx + rx;
        led[o++] = cy + ry;
        led[o++] = t;
        led[o++] = k;
      }
    });

    this.mapBuffer?.destroy();
    this.mapBuffer = this.device.createBuffer({
      size: led.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.queue.writeBuffer(this.mapBuffer, 0, led);

    this.fixParamsBuffer?.destroy();
    this.fixParamsBuffer = this.device.createBuffer({
      size: Math.max(32, fix.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.queue.writeBuffer(this.fixParamsBuffer, 0, fix);

    const outBytes = newTotal * 4;
    this.outBuffer?.destroy();
    this.outBuffer = this.device.createBuffer({
      size: outBytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    for (const s of this.staging) s.destroy();
    this.staging = [];
    this.stagingBusy = [];
    for (let i = 0; i < STAGING_COUNT; i++) {
      this.staging.push(this.device.createBuffer({
        size: outBytes,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }));
      this.stagingBusy.push(false);
    }
    this.stagingCursor = 0;
    this.latest = new Uint8Array(outBytes);

    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: this.srcTexture.createView() },
        { binding: 2, resource: { buffer: this.mapBuffer } },
        { binding: 3, resource: { buffer: this.outBuffer } },
        { binding: 4, resource: { buffer: this.paramsBuffer } },
        { binding: 5, resource: this.paletteTexture.createView() },
        { binding: 6, resource: { buffer: this.fixParamsBuffer } },
      ],
    });
  }

  // Cheap path: only the per-fixture effect params changed (sliders/dropdowns).
  updateParams(fixtures: Fixture[]): void {
    if (this.disposed || !this.fixParamsBuffer) return;
    if (fixtures.length !== this.fixCount) return; // count change -> updateMapping handles it
    const fix = new Float32Array(fixtures.length * 8);
    fixtures.forEach((f, k) => this.fixtureParamVec(f, fix, k));
    this.queue.writeBuffer(this.fixParamsBuffer, 0, fix);
  }

  updateSource(source: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement): void {
    if (this.disposed) return;
    try {
      this.queue.copyExternalImageToTexture(
        { source: source as GPUCopyExternalImageSource, flipY: false },
        { texture: this.srcTexture },
        [SOURCE_SIZE, SOURCE_SIZE],
      );
    } catch {
      // Source not ready yet; ignore this frame.
    }
  }

  read(): Uint8Array | null {
    if (this.disposed || this.totalLeds === 0 || !this.bindGroup || !this.outBuffer) {
      return this.latest && this.totalLeds > 0 ? this.latest : null;
    }

    const params = new ArrayBuffer(16);
    const dv = new DataView(params);
    dv.setFloat32(0, this.brightness, true);
    dv.setFloat32(4, (performance.now() - this.startTime) / 1000, true);
    dv.setUint32(8, this.totalLeds, true);
    dv.setUint32(12, this.paletteCount, true);
    this.queue.writeBuffer(this.paramsBuffer, 0, params);

    const idx = this.findFreeStaging();
    if (idx === -1) return this.latest;

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.totalLeds / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(this.outBuffer, 0, this.staging[idx], 0, this.totalLeds * 4);
    this.queue.submit([encoder.finish()]);

    this.stagingBusy[idx] = true;
    const buf = this.staging[idx];
    buf.mapAsync(GPUMapMode.READ).then(() => {
      if (this.disposed) return;
      const copy = new Uint8Array(buf.getMappedRange());
      if (this.latest && this.latest.length === copy.length) this.latest.set(copy);
      buf.unmap();
      this.stagingBusy[idx] = false;
    }).catch(() => {
      this.stagingBusy[idx] = false;
    });

    return this.latest;
  }

  private findFreeStaging(): number {
    for (let n = 0; n < this.staging.length; n++) {
      const i = (this.stagingCursor + n) % this.staging.length;
      if (!this.stagingBusy[i]) {
        this.stagingCursor = (i + 1) % this.staging.length;
        return i;
      }
    }
    return -1;
  }

  dispose(): void {
    this.disposed = true;
    this.mapBuffer?.destroy();
    this.fixParamsBuffer?.destroy();
    this.outBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.srcTexture?.destroy();
    this.paletteTexture?.destroy();
    for (const s of this.staging) {
      try { s.destroy(); } catch { /* may be mapped */ }
    }
    this.staging = [];
    this.latest = null;
    this.device.destroy();
  }
}
