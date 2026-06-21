import { Fixture } from '../types';
import { IPixelMapper } from '../services/PixelMapper';

// WebGPU compute-based pixel mapper. Drop-in replacement for the WebGL GPUMapper:
// samples the source at each LED's UV and converts RGB->RGBW (subtract-min, for
// parity with the WebGL shader) entirely on the GPU, then reads back the result
// asynchronously (mapAsync + a staging-buffer ring) to avoid the synchronous
// gl.readPixels stall. `read()` returns the most recently resolved frame.

const SOURCE_SIZE = 512;          // Stage canvas is 512x512
const WORKGROUP = 64;
const STAGING_COUNT = 3;

const SHADER = /* wgsl */ `
struct Params { brightness: f32, count: u32 };

@group(0) @binding(0) var srcSampler: sampler;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> ledUV: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> outBuf: array<u32>;
@group(0) @binding(4) var<uniform> params: Params;

fn toByte(v: f32) -> u32 {
  return u32(clamp(v, 0.0, 1.0) * 255.0 + 0.5);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.count) { return; }

  let uv = ledUV[i];
  let color = textureSampleLevel(srcTex, srcSampler, uv, 0.0);

  let minVal = min(min(color.r, color.g), color.b);
  let b = params.brightness;
  let r = toByte((color.r - minVal) * b);
  let g = toByte((color.g - minVal) * b);
  let bl = toByte((color.b - minVal) * b);
  let w = toByte(minVal * b);

  // Pack RGBW into one u32; little-endian readback yields bytes [r,g,b,w].
  outBuf[i] = r | (g << 8u) | (bl << 16u) | (w << 24u);
}
`;

export class WebGPUMapper implements IPixelMapper {
  private device: GPUDevice;
  private queue: GPUQueue;
  private pipeline: GPUComputePipeline;
  private sampler: GPUSampler;
  private srcTexture: GPUTexture;

  private mapBuffer: GPUBuffer | null = null;
  private outBuffer: GPUBuffer | null = null;
  private paramsBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup | null = null;

  private staging: GPUBuffer[] = [];
  private stagingBusy: boolean[] = [];
  private stagingCursor = 0;

  private totalLeds = 0;
  private brightness = 1.0;
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

    this.paramsBuffer = device.createBuffer({
      size: 8, // f32 brightness + u32 count
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

  updateMapping(fixtures: Fixture[]): void {
    if (this.disposed) return;
    const newTotal = fixtures.reduce((acc, f) => acc + f.ledCount, 0);
    this.totalLeds = newTotal;
    if (newTotal === 0) return;

    // Per-LED UVs (same math as the WebGL GPUMapper, but without the Y flip:
    // WebGPU copies the canvas top-row to texture y=0, so v is used directly).
    const data = new Float32Array(newTotal * 2);
    let o = 0;
    for (const f of fixtures) {
      const cx = f.x + f.width / 2;
      const cy = f.y + f.height / 2;
      const rads = (f.rotation || 0) * (Math.PI / 180);
      const cos = Math.cos(rads);
      const sin = Math.sin(rads);
      const isHoriz = f.width >= f.height;
      for (let i = 0; i < f.ledCount; i++) {
        let relX = 0, relY = 0;
        if (isHoriz) {
          const step = f.width / f.ledCount;
          relX = i * step + step / 2 - f.width / 2;
        } else {
          const step = f.height / f.ledCount;
          relY = i * step + step / 2 - f.height / 2;
        }
        const rx = relX * cos - relY * sin;
        const ry = relX * sin + relY * cos;
        data[o++] = cx + rx;
        data[o++] = cy + ry;
      }
    }

    // (Re)allocate GPU buffers sized to the LED count.
    this.mapBuffer?.destroy();
    this.mapBuffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.queue.writeBuffer(this.mapBuffer, 0, data);

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
      ],
    });
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

    // Update params (brightness + count).
    const params = new ArrayBuffer(8);
    new DataView(params).setFloat32(0, this.brightness, true);
    new DataView(params).setUint32(4, this.totalLeds, true);
    this.queue.writeBuffer(this.paramsBuffer, 0, params);

    // Pick a free staging buffer; if all are in flight, skip dispatch this frame.
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
    this.outBuffer?.destroy();
    this.paramsBuffer?.destroy();
    this.srcTexture?.destroy();
    for (const s of this.staging) {
      try { s.destroy(); } catch { /* may be mapped */ }
    }
    this.staging = [];
    this.latest = null;
    this.device.destroy();
  }
}
