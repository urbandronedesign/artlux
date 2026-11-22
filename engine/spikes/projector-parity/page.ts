// E1e-1 projector parity, the APP's side: its REAL ProjectorGL (the 2D warp path every uncalibrated output
// takes) drawing each picture through each case's settings — the Bézier net tessellated exactly as
// ProjectorApp does (tessellateBezier, RENDER_TESS 24) — read back with ProjectorGL's own captureRGBA.
// Run by scripts/test-projector-parity.cjs through engine/spikes/sampling-parity/main.js.
import { ProjectorGL } from '../../../src/renderer/projector/ProjectorGL';
import { tessellateBezier } from '../../../src/renderer/projector/warp';

const nodeRequire = (window as any).require;
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const OUT = nodeRequire('process').env.SPIKE_OUT as string;
const b64 = (u8: Uint8Array): string => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

(async () => {
  const result: any = { pictures: [] };
  try {
    const job = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'));
    for (const pic of job.pictures) {
      const bmp = await createImageBitmap(new Blob([fs.readFileSync(pic)]));
      const canvas = document.createElement('canvas');
      canvas.width = job.width; canvas.height = job.height;
      const gl = new ProjectorGL(canvas);
      const cases = [];
      for (const c of job.cases) {
        const o = c.output;
        const mesh = o.warp ? tessellateBezier(o.warp, 24) : null;
        const opts = { cornerPin: o.cornerPin, warp: mesh, softEdge: o.softEdge, gamma: o.gamma, brightness: c.brightness, colorGain: o.colorGain, blackLift: o.blackLift, aa: c.aa };
        if (c.baked) {
          // The calibration plugin's hand-off, as ProjectorApp applies it: setBakedMap, then the rig blend.
          const buf = fs.readFileSync(c.baked.uv);
          const uv = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
          if (!(gl.setBakedMap(c.baked.w, c.baked.h, uv) && gl.canDrawBaked())) throw new Error('baked map unusable here');
          gl.setBakedAlpha(c.baked.alpha ? { w: c.baked.alpha.w, h: c.baked.alpha.h, data: new Uint8Array(fs.readFileSync(c.baked.alpha.file)) } : null);
          if (!gl.drawBaked(bmp, opts)) throw new Error('drawBaked refused');
        } else {
          gl.draw(bmp, opts);
        }
        const cap = gl.captureRGBA(job.width, job.height)!;
        cases.push({ name: c.name, rgba: b64(cap.data) });
      }
      gl.dispose();
      result.pictures.push({ picture: pic, cases });
    }
  } catch (e: any) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(path.join(OUT, 'gpu-cases.json'), JSON.stringify(result));
  window.close();
})();
