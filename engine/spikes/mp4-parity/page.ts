// Item 2c — MP4 parity, the APP's side. Encodes synthetic pictures into real MP4s (WebCodecs + mediabunny,
// as test:frame-exact does — H.264 and H.265), decodes each through the app's REAL plugins/mp4 FileDecoder
// (layerFrameExact: the exact frame, not a neighbour), and writes, per file:
//   • `<name>.nv12.json` + `<name>.planes.bin` — the VideoFrame's CODED planes (copyTo over the coded rect:
//     Chromium's stretch reads the encoder's padding past the visible edge), its visible rect and colour
//     space. Bit-exact decoder output by the codec standard — what the engine's own decoder is held to;
//   • `<name>.rgba-1to1.bin` — the picture Chromium makes of it, drawn 1:1 into a 2D canvas (the atlas's kind).
// Then the LED jobs: the app's REAL WebGPUMapper with those VideoFrames as the surfaces' drawables, exactly
// as frameEngine hands it mp4Codec.surfaceFrame's VideoFrame. Writes the canonical RGBW buffer per job.
// Run by scripts/test-mp4-parity.cjs through engine/spikes/sampling-parity/main.js.
import { Output, Mp4OutputFormat, BufferTarget, CanvasSource } from 'mediabunny';
import * as dec from '../../../plugins/mp4/src/mp4Decoder';
import { WebGPUMapper } from '../../../src/renderer/gpu/WebGPUMapper';

const nodeRequire = (window as any).require;
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const OUT = nodeRequire('process').env.SPIKE_OUT as string;
const b64 = (u8: Uint8Array): string => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Synthetic pictures: sharp lines + gradients + a checker (chroma edges), per-pixel noise, a smooth "photo".
function paint(ctx: CanvasRenderingContext2D, kind: string, w: number, h: number, frame: number) {
  const img = ctx.createImageData(w, h);
  const r = rng(7 + frame);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let c: number[];
    if (kind === 'noise') c = [r() * 256, r() * 256, r() * 256];
    else if (kind === 'sharp') c = (x % 97 === frame || y % 89 === 0) ? [255, 255, 255] : [(x / (w - 1)) * 255, (y / (h - 1)) * 255, ((x >> 5) + (y >> 5)) % 2 ? 230 : 20];
    else c = [128 + 120 * Math.sin(x / 40 + frame), 128 + 120 * Math.cos(y / 30), 128 + 100 * Math.sin((x + y) / 55)];
    img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

async function makeMp4(kind: string, w: number, h: number, codec: 'avc' | 'hevc', frames: number, fps = 30): Promise<ArrayBuffer> {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(cv, { codec, bitrate: 20_000_000, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  for (let i = 0; i < frames; i++) { paint(ctx, kind, w, h, i); await source.add(i / fps, 1 / fps); }
  await output.finalize();
  return target.buffer!;
}

function draw1to1(src: CanvasImageSource, w: number, h: number): Uint8Array {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0, w, h);
  return new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer);
}

(async () => {
  const result: any = { files: [], cases: [] };
  const frames = new Map<string, VideoFrame>();   // .nv12.json path → the app's VideoFrame
  try {
    const job = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));
    const urls: Record<string, string> = {};
    (globalThis as any).__mediaUrls = urls;
    for (const c of job.files) {
      const entry: any = { name: c.name };
      result.files.push(entry);
      try {
        let src: string = c.file;
        if (!src) {
          const codec = c.codec === 'hevc' ? 'hvc1.1.6.L120.B0' : 'avc1.640034';
          if (!(await VideoEncoder.isConfigSupported({ codec, width: c.w, height: c.h })).supported) { entry.skipped = `no ${c.codec} encoder here`; continue; }
          src = path.join(OUT, c.name + '.mp4');
          fs.writeFileSync(src, new Uint8Array(await makeMp4(c.kind, c.w, c.h, c.codec, c.frames, c.fps)));
        }
        entry.file = src;
        urls[src] = URL.createObjectURL(new Blob([fs.readFileSync(src)]));
        if (!(await dec.ensureOpen(src))) { entry.error = 'mp4Decoder could not open it'; continue; }
        const info = dec.sourceInfo(src)!;
        const got = await dec.layerFrameExact(`mp4parity:${c.name}`, src, (c.frame + 0.5) / info.fps) as VideoFrame | null;
        if (!got) { entry.error = 'no frame'; continue; }
        const vf = got.clone();   // ours: the decoder may close its own as it moves on
        dec.releaseLayer(`mp4parity:${c.name}`);
        const rect = { x: 0, y: 0, width: vf.codedWidth, height: vf.codedHeight };
        const buf = new Uint8Array(vf.allocationSize({ rect }));
        const layout = await vf.copyTo(buf, { rect });
        const v = vf.visibleRect!;
        const meta = { coded: [vf.codedWidth, vf.codedHeight], visible: [v.x, v.y, v.width, v.height], display: [vf.displayWidth, vf.displayHeight],
          format: vf.format, colorSpace: vf.colorSpace.toJSON(), layout, timestamp: vf.timestamp, planes: c.name + '.planes.bin' };
        fs.writeFileSync(path.join(OUT, c.name + '.planes.bin'), buf);
        fs.writeFileSync(path.join(OUT, c.name + '.nv12.json'), JSON.stringify(meta));
        fs.writeFileSync(path.join(OUT, c.name + '.rgba-1to1.bin'), draw1to1(vf, vf.displayWidth, vf.displayHeight));
        Object.assign(entry, meta);
        frames.set(path.join(OUT, c.name + '.nv12.json'), vf);
        // Item 2c-2: more frames, IN THE ORDER GIVEN (a backward one makes the decoder seek), for the
        // engine's own decoder to be held to: `<name>.app.f<k>` — the same layout as above.
        entry.dumped = [];
        for (const [k, idx] of (c.dump ?? []).entries()) {
          const g = await dec.layerFrameExact(`mp4parity:${c.name}:dump`, src, (idx + 0.5) / info.fps) as VideoFrame | null;
          if (!g) { entry.dumped.push(null); continue; }
          const r2 = { x: 0, y: 0, width: g.codedWidth, height: g.codedHeight };
          const b2 = new Uint8Array(g.allocationSize({ rect: r2 }));
          const l2 = await g.copyTo(b2, { rect: r2 });
          const v2 = g.visibleRect!;
          fs.writeFileSync(path.join(OUT, `${c.name}.app.f${k}.planes.bin`), b2);
          const m2 = { coded: [g.codedWidth, g.codedHeight], visible: [v2.x, v2.y, v2.width, v2.height], format: g.format, colorSpace: g.colorSpace.toJSON(), layout: l2, timestamp: g.timestamp, planes: `${c.name}.app.f${k}.planes.bin` };
          fs.writeFileSync(path.join(OUT, `${c.name}.app.f${k}.nv12.json`), JSON.stringify(m2));
          entry.dumped.push(g.timestamp);
        }
        dec.releaseLayer(`mp4parity:${c.name}:dump`);
      } catch (e: any) { entry.error = String(e && e.stack || e); }
    }
    // The LED jobs: the app's real mapper, the VideoFrames as drawables.
    const adapter = await (navigator as any).gpu.requestAdapter();
    result.adapter = adapter?.info ? `${adapter.info.vendor} ${adapter.info.architecture} (Chromium WebGPU)` : 'unknown';
    const mapper = await WebGPUMapper.create();
    if (!mapper) throw new Error('no WebGPU');
    const m = mapper as any;
    const device: GPUDevice = m.getDevice();
    for (const j of job.jobs) {
      mapper.setBrightness(j.brightness);
      mapper.updateMapping(j.fixtures, j.surfaces);
      const byId = new Map(j.surfaces.map((s: any) => [s.id, s]));
      mapper.renderSurfaces((id) => frames.get((byId.get(id) as any)?.content?.url) ?? null, (id) => (byId.get(id) as any)?.content?.opacity ?? 1);
      await device.queue.onSubmittedWorkDone();
      for (let t = 0; t < 100 && m.stagingBusy.some(Boolean); t++) await new Promise((r) => setTimeout(r, 10));
      result.cases.push({ name: j.name, rgbw: b64(mapper.read()!.slice()) });
    }
    mapper.dispose();
  } catch (e: any) { result.error = String(e && e.stack || e); }
  for (const f of frames.values()) try { f.close(); } catch { /* closed */ }
  fs.writeFileSync(path.join(OUT, 'gpu-cases.json'), JSON.stringify(result));
  window.close();
})();
