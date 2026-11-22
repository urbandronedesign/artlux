// E1d image parity, browser side: the app's REAL WebGPUMapper with surfaces whose drawables are
// ImageBitmaps decoded exactly as services/contentSource does it (createImageBitmap of the file's blob),
// opacity as frameEngine passes it (content.opacity ?? 1). Writes the canonical RGBW buffer per job.
// Run by scripts/test-image-parity.cjs through engine/spikes/sampling-parity/main.js.
import { WebGPUMapper } from '../../../src/renderer/gpu/WebGPUMapper';

const nodeRequire = (window as any).require;
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const OUT = nodeRequire('process').env.SPIKE_OUT as string;
const b64 = (u8: Uint8Array): string => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

(async () => {
  const result: any = { cases: [] };
  try {
    const jobs = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));
    const adapter = await (navigator as any).gpu.requestAdapter();
    const ai = adapter?.info;
    result.adapter = ai ? `${ai.vendor} ${ai.architecture} (Chromium WebGPU)` : 'unknown';
    const mapper = await WebGPUMapper.create();
    if (!mapper) throw new Error('no WebGPU');
    const m = mapper as any;
    const device: GPUDevice = m.getDevice();
    const bitmaps = new Map<string, ImageBitmap>();
    for (const job of jobs) {
      for (const s of job.surfaces) {
        const url = s.content?.type === 'IMAGE' ? s.content.url : null;
        if (url && !bitmaps.has(url)) bitmaps.set(url, await createImageBitmap(new Blob([fs.readFileSync(url)])));
      }
      mapper.setBrightness(job.brightness);
      mapper.updateMapping(job.fixtures, job.surfaces);
      const byId = new Map(job.surfaces.map((s: any) => [s.id, s]));
      mapper.renderSurfaces(
        (id) => { const s: any = byId.get(id); return s?.content?.type === 'IMAGE' ? bitmaps.get(s.content.url) ?? null : null; },
        (id) => (byId.get(id) as any)?.content?.opacity ?? 1);
      await device.queue.onSubmittedWorkDone();
      for (let t = 0; t < 100 && m.stagingBusy.some(Boolean); t++) await new Promise((r) => setTimeout(r, 10));
      result.cases.push({ name: job.name, rgbw: b64(mapper.read()!.slice()) });
    }
    mapper.dispose();
  } catch (e: any) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(path.join(OUT, 'gpu-cases.json'), JSON.stringify(result));
  window.close();
})();
