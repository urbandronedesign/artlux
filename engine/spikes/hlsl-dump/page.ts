// Diagnostic (plans/native-engine.md, the plain warp's soft-edge residue): the HLSL ANGLE generates for the
// app's REAL ProjectorGL shaders, through WEBGL_debug_shaders (a privileged extension: the runner passes
// SPIKE_SWITCHES=enable-privileged-webgl-extensions). Every shader ProjectorGL compiles is recorded, then its
// translation is written to SPIKE_OUT/angle-<n>.hlsl. Compare with `artlux-engine --dump-hlsl`.
// Run: node scripts/dump-hlsl.cjs
import { ProjectorGL } from '../../../src/renderer/projector/ProjectorGL';

const nodeRequire = (window as any).require;
const fs = nodeRequire('fs');
const path = nodeRequire('path');
const OUT = nodeRequire('process').env.SPIKE_OUT as string;

(async () => {
  const result: any = { shaders: [] };
  try {
    const shaders: { shader: WebGLShader; gl: WebGL2RenderingContext | WebGLRenderingContext; src: string }[] = [];
    for (const proto of [WebGL2RenderingContext.prototype, WebGLRenderingContext.prototype] as any[]) {
      const real = proto.shaderSource;
      proto.shaderSource = function (this: any, sh: WebGLShader, src: string) { shaders.push({ shader: sh, gl: this, src }); return real.call(this, sh, src); };
    }
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 36;
    const pgl = new ProjectorGL(canvas);
    const bmp = await createImageBitmap(new ImageData(new Uint8ClampedArray(64 * 36 * 4).fill(200), 64, 36));
    pgl.draw(bmp, { cornerPin: { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] }, warp: null, softEdge: { left: 0.1, right: 0, top: 0, bottom: 0.1, gamma: 2.2 }, gamma: 1, brightness: 1, colorGain: [1, 1, 1], blackLift: [0, 0, 0], aa: 4 } as any);
    for (const [k, s] of shaders.entries()) {
      const ext = (s.gl as any).getExtension('WEBGL_debug_shaders');
      if (!ext) { result.error = 'no WEBGL_debug_shaders (is enable-privileged-webgl-extensions on?)'; break; }
      const t = ext.getTranslatedShaderSource(s.shader);
      fs.writeFileSync(path.join(OUT, `angle-${k}.glsl`), s.src);
      fs.writeFileSync(path.join(OUT, `angle-${k}.hlsl`), t);
      result.shaders.push({ k, glslHead: s.src.slice(0, 80), bytes: t.length });
    }
    result.renderer = (() => { const gl = canvas.getContext('webgl2') as any; const d = gl?.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : '?'; })();
  } catch (e: any) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(path.join(OUT, 'gpu-cases.json'), JSON.stringify(result, null, 1));
  window.close();
})();
