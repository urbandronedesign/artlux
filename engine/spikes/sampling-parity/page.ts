// The browser side of E1b-2's GPU parity: the app's REAL WebGPUMapper on synthetic surfaces. For each case
// it records what the engine needs to sample the same thing — the exact atlas pixels the mapper uploaded
// (its scratch canvas), the layout buffers, the brightness, the surface count — and the bytes the mapper
// read back. (Private fields are read through `any`: this is a harness, not a consumer.)
import { WebGPUMapper } from '../../../src/renderer/gpu/WebGPUMapper';
import { buildLedData, buildSegParams, countSegments, surfaceOrderOf, atlasRectData } from '../../../src/renderer/gpu/ledLayout';

const nodeRequire = (window as any).require;
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const OUT = nodeRequire('process').env.SPIKE_OUT as string;

const b64 = (u8: Uint8Array): string => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const f32b64 = (f: Float32Array): string => b64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));

// A surface picture: odd sizes, gradients + texture, so bilinear filtering decides real values.
const SIZES = [[97, 61], [160, 90], [33, 200], [256, 256], [17, 9]];
function drawable(k: number): HTMLCanvasElement {
  const [w, h] = SIZES[k % SIZES.length];
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    img.data[i] = (x * 255 / Math.max(1, w - 1) + k * 40) & 255;
    img.data[i + 1] = (y * 255 / Math.max(1, h - 1)) & 255;
    img.data[i + 2] = ((x * 7) ^ (y * 13) ^ (k * 29)) & 255;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

(async () => {
  const result: any = { cases: [] };
  try {
    const cases = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));
    const adapter = await (navigator as any).gpu.requestAdapter();
    const ai = adapter?.info;
    result.adapter = ai ? `${ai.vendor} ${ai.architecture} ${ai.description || ''} (Chromium WebGPU)`.trim() : 'unknown';
    const mapper = await WebGPUMapper.create();
    if (!mapper) throw new Error('WebGPUMapper.create() returned null — no WebGPU here');
    const m = mapper as any;
    const device: GPUDevice = m.getDevice();
    let k = 0;
    for (const c of cases) {
      k++;
      const brightness = [1, 0.73, 0.5][k % 3];
      mapper.setBrightness(brightness);
      mapper.updateMapping(c.fixtures, c.surfaces);
      if (!m.totalLeds || m.atlasW * m.atlasH > 2048 * 2048) continue;
      const pics = new Map<string, HTMLCanvasElement>();
      c.surfaces.forEach((s: any, i: number) => pics.set(s.id, drawable(i)));
      mapper.renderSurfaces((id) => pics.get(id) ?? null, (id) => (id === c.surfaces[1]?.id ? 0.6 : 1));
      await device.queue.onSubmittedWorkDone();
      for (let t = 0; t < 100 && m.stagingBusy.some(Boolean); t++) await new Promise((r) => setTimeout(r, 10));
      const out: Uint8Array = mapper.read()!.slice();
      const atlas = m.scratchCtx.getImageData(0, 0, m.atlasW, m.atlasH).data as Uint8ClampedArray;
      const order = surfaceOrderOf(c.fixtures, c.surfaces);
      const segCount = countSegments(c.fixtures);
      const d = buildLedData(c.fixtures, c.surfaces, order, segCount);
      result.cases.push({
        name: c.name, atlasW: m.atlasW, atlasH: m.atlasH, atlas: b64(new Uint8Array(atlas.buffer)),
        led: f32b64(d.led), meta: f32b64(d.meta), segParams: f32b64(buildSegParams(c.fixtures)),
        rects: f32b64(atlasRectData(m.atlasRectsPx, m.atlasW, m.atlasH)),
        brightness: m.brightness, surfaces: m.surfaceOrder.length, out: b64(out),
      });
    }
    mapper.dispose();
  } catch (e: any) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(path.join(OUT, 'gpu-cases.json'), JSON.stringify(result));
  window.close();
})();
