// E1d image parity, browser side: the app's REAL WebGPUMapper with surfaces whose drawables are
// ImageBitmaps decoded exactly as services/contentSource does it (createImageBitmap of the file's blob),
// opacity as frameEngine passes it (content.opacity ?? 1); HAP video frames through the HAP plugin's own GL
// path (E1d-2). Writes the canonical RGBW buffer per job.
// Run by scripts/test-image-parity.cjs through engine/spikes/sampling-parity/main.js.
import { WebGPUMapper } from '../../../src/renderer/gpu/WebGPUMapper';
import { uploadFrame } from '../../../plugins/hap/src/hapGL';

const nodeRequire = (window as any).require;
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const OUT = nodeRequire('process').env.SPIKE_OUT as string;
const OUT_ROOT = () => nodeRequire('process').env.SPIKE_ROOT as string;
let hapAddon: any = null;
const hapNative = () => (hapAddon ??= nodeRequire(path.resolve(OUT_ROOT(), 'native', 'hap', 'hap.node')));
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
      // VIDEO surfaces whose file is HAP: the frame's BLOCKS, as the app's HAP plugin gets them (the native
      // addon's decodeFrameBlocks — or a synthetic `.hapframe.json` test frame), fetched first...
      const hapFrames = new Map<string, any>();
      for (const s of job.surfaces) {
        if (s.content?.type !== 'VIDEO') continue;
        const url: string = s.content.url;
        hapFrames.set(s.id, url.endsWith('.hapframe.json')
          ? (() => { const j = JSON.parse(fs.readFileSync(url, 'utf8')); return { ...j, data: Uint8Array.from(atob(j.data), (c) => c.charCodeAt(0)) }; })()
          : (hapNative().open(url), await hapNative().decodeFrameBlocks(url, job.videoFrame)));
      }
      mapper.setBrightness(job.brightness);
      mapper.updateMapping(job.fixtures, job.surfaces);
      const byId = new Map(job.surfaces.map((s: any) => [s.id, s]));
      // ...then painted by the app's REAL GL path (hapGL.uploadFrame — the canvas surfaceMedia hands the
      // mapper) and drawn in the SAME task: a WebGL canvas's drawing buffer is not kept past it.
      const canvases = new Map<string, any>();
      for (const [id, f] of hapFrames) canvases.set(id, uploadFrame(id, f));
      mapper.renderSurfaces(
        (id) => { const s: any = byId.get(id); return s?.content?.type === 'IMAGE' ? bitmaps.get(s.content.url) ?? null : canvases.get(id) ?? null; },
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
