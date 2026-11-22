// E1d image parity, browser side: the app's REAL WebGPUMapper with surfaces whose drawables are
// ImageBitmaps decoded exactly as services/contentSource does it (createImageBitmap of the file's blob),
// opacity as frameEngine passes it (content.opacity ?? 1); HAP video frames through the HAP plugin's own GL
// path (E1d-2); Spout VideoFrames from the shared-texture relay (E1d-3, engine/spikes/spout-parity). Writes the canonical RGBW buffer per job.
// Run by scripts/test-image-parity.cjs through engine/spikes/sampling-parity/main.js.
import { WebGPUMapper } from '../../../src/renderer/gpu/WebGPUMapper';
import { uploadFrame } from '../../../plugins/hap/src/hapGL';
import { SurfaceEffect } from '../../../src/renderer/gpu/surfaceFx';

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
    // SPOUT (E1d-3): the newest VideoFrame from the shared-texture relay, kept and closed as the plugin's
    // spoutReceiver.ts does. Wait for a few before drawing, so the drawn one is a settled frame.
    let spoutFrame: VideoFrame | null = null;
    result.frames = 0;
    if (jobs.some((j: any) => j.surfaces.some((s: any) => s.content?.type === 'SPOUT'))) {
      window.addEventListener('message', (e: MessageEvent) => {
        const d = e.data;
        if (d?.kind !== 'artlux:shared-texture' || d.channel !== 'spout' || !d.frame) return;
        try { spoutFrame?.close(); } catch { /* closed */ }
        spoutFrame = d.frame; result.frames++;
      });
      for (let t = 0; t < 200 && result.frames < 10; t++) await new Promise((r) => setTimeout(r, 50));
      if (!spoutFrame) throw new Error('no Spout frame arrived');
    }
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
      // EFFECT surfaces (E1d-4): the app's REAL SurfaceEffect, one per surface, rendered at each of the job's
      // times in order (surfaces in document order within a time), with Math.random swapped for the
      // seeded mulberry32 stream the engine uses — ONLY around these calls, so nothing else draws from it.
      const fields = new Map<string, any>();
      const fx = job.surfaces.filter((s: any) => s.content?.type === 'EFFECT').map((s: any) => [s, new SurfaceEffect()] as const);
      if (fx.length) {
        const real = Math.random;
        let seed = (job.effectSeed ?? 1) >>> 0;
        Math.random = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        try {
          for (const t of job.effectTimes) for (const [s, e] of fx) e.render(s.content, t);
          const last = job.effectTimes[job.effectTimes.length - 1];
          for (const [s, e] of fx) fields.set(s.id, e.render(s.content, last));   // cached: no extra step
        } finally { Math.random = real; }
      }
      mapper.setBrightness(job.brightness);
      mapper.updateMapping(job.fixtures, job.surfaces);
      const byId = new Map(job.surfaces.map((s: any) => [s.id, s]));
      // ...then painted by the app's REAL GL path (hapGL.uploadFrame — the canvas surfaceMedia hands the
      // mapper) and drawn in the SAME task: a WebGL canvas's drawing buffer is not kept past it.
      const canvases = new Map<string, any>();
      for (const [id, f] of hapFrames) canvases.set(id, uploadFrame(id, f));
      mapper.renderSurfaces(
        (id) => { const s: any = byId.get(id); return s?.content?.type === 'IMAGE' ? bitmaps.get(s.content.url) ?? null : s?.content?.type === 'SPOUT' ? spoutFrame : s?.content?.type === 'EFFECT' ? fields.get(id) ?? null : canvases.get(id) ?? null; },
        (id) => (byId.get(id) as any)?.content?.opacity ?? 1);
      // The fields themselves, for the reference — read AFTER the draw, so reading cannot change how it drew.
      result.fields ??= {};
      for (const [id, c] of fields) result.fields[id] = b64(new Uint8Array(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer));
      await device.queue.onSubmittedWorkDone();
      for (let t = 0; t < 100 && m.stagingBusy.some(Boolean); t++) await new Promise((r) => setTimeout(r, 10));
      result.cases.push({ name: job.name, rgbw: b64(mapper.read()!.slice()) });
    }
    mapper.dispose();
  } catch (e: any) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(path.join(OUT, 'gpu-cases.json'), JSON.stringify(result));
  window.close();
})();
