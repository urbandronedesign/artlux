import type { CornerPin, WarpGrid, SoftEdge } from '../../../shared/protocol';
import { cornerQs, toClip } from './homography';
import * as blobPass from '../gpu/blobPass';
import type { BlobInst } from '../gpu/blobPass';

// LiDAR blob content rendered straight into the source FBO on the GPU (no CPU canvas, no per-frame
// full-canvas upload): bg video + soft blob discs + optional overlay → warped onto the display.
export interface TrackingOpts {
  srcW: number; srcH: number;
  bgSource?: TexImageSource | null;   // background video frame (decoded in main, streamed here)
  trails?: Float32Array | null;       // comet-trail ribbon vertices (drawn under the blobs)
  blobs: BlobInst[];
  overlaySource?: TexImageSource | null; // calibration / #id overlay (only when enabled)
}

// Renders one surface's content as either a perspective-correct corner-pinned quad or a
// grid-mesh warp, with per-output soft-edge blending + gamma, into a multisampled WebGL2
// framebuffer (MSAA) that is resolved to the screen. Falls back to a plain WebGL1 context
// (context-level antialias) when WebGL2 is unavailable.

export interface DrawOpts {
  cornerPin: CornerPin;
  warp?: WarpGrid | null;
  softEdge?: SoftEdge;
  gamma?: number;      // output gamma (1 = off)
  brightness?: number; // projector-content master brightness (1 = full)
  colorGain?: [number, number, number]; // per-projector white-point/brightness match (default 1,1,1)
  blackLift?: [number, number, number]; // per-projector additive black floor (default 0,0,0)
  aa?: number;         // MSAA samples (0/1 = off)
}

const VERT = `
attribute vec2 aPos;     // clip-space position
attribute vec3 aUVQ;     // (u*q, v*q, q) — q=1 for mesh, perspective q for corner-pin
varying vec3 vUVQ;
void main() {
  vUVQ = aUVQ;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec3 vUVQ;
uniform sampler2D uTex;
uniform vec4 uSoft;        // left, right, top, bottom feather widths (0 = hard)
uniform float uBlendGamma; // soft-edge ramp shaping
uniform float uGamma;      // output gamma (1 = off)
uniform float uBrightness; // projector-content master brightness (1 = full)
uniform vec3 uColorGain;   // per-channel white-point/brightness match across projectors (1,1,1 = off)
uniform vec3 uBlackLift;   // per-channel additive black floor to match overlap black (0,0,0 = off)
float feather(float d, float w) { return w <= 0.0 ? 1.0 : clamp(d / w, 0.0, 1.0); }
void main() {
  vec2 uv = vUVQ.xy / vUVQ.z;
  vec4 c = texture2D(uTex, uv);
  float a = feather(uv.x, uSoft.x) * feather(1.0 - uv.x, uSoft.y)
          * feather(uv.y, uSoft.z) * feather(1.0 - uv.y, uSoft.w);
  float pa = pow(a, uBlendGamma);
  // Edge blend × per-projector colour gain, plus the black floor where content is attenuated so an
  // overlap's doubled black matches the single-projector black. Identity at gain=1, lift=0.
  c.rgb = c.rgb * pa * uColorGain + uBlackLift * (1.0 - pa);
  c.rgb *= uBrightness;
  c.rgb = pow(max(c.rgb, 0.0), vec3(1.0 / uGamma));
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`[ProjectorGL] shader: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

export class ProjectorGL {
  private gl: WebGLRenderingContext;
  private gl2: WebGL2RenderingContext | null;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  private aPos: number;
  private aUVQ: number;
  private uSoft: WebGLUniformLocation | null;
  private uBlendGamma: WebGLUniformLocation | null;
  private uGamma: WebGLUniformLocation | null;
  private uBrightness: WebGLUniformLocation | null;
  private uColorGain: WebGLUniformLocation | null;
  private uBlackLift: WebGLUniformLocation | null;
  // MSAA (WebGL2 only)
  private msFBO: WebGLFramebuffer | null = null;
  private msColor: WebGLRenderbuffer | null = null;
  private msW = 0; private msH = 0; private msSamples = 0;
  // Capped readback target for NDI capture (WebGL2 only)
  private capFBO: WebGLFramebuffer | null = null;
  private capTex: WebGLTexture | null = null;
  private capW = 0; private capH = 0;
  // Source FBO for GPU-composited TRACKING content (bg + blobs + overlay → warp)
  private srcFBO: WebGLFramebuffer | null = null;
  private srcTex: WebGLTexture | null = null;
  private bgTex: WebGLTexture | null = null;
  private overlayTex: WebGLTexture | null = null;
  private srcW = 0; private srcH = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl2 = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false }) as WebGL2RenderingContext | null;
    const gl = (gl2 ?? canvas.getContext('webgl', { premultipliedAlpha: false, antialias: true })) as WebGLRenderingContext | null;
    if (!gl) throw new Error('[ProjectorGL] WebGL unavailable');
    this.gl = gl; this.gl2 = gl2;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`[ProjectorGL] link: ${gl.getProgramInfoLog(prog)}`);
    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.aUVQ = gl.getAttribLocation(prog, 'aUVQ');
    this.uSoft = gl.getUniformLocation(prog, 'uSoft');
    this.uBlendGamma = gl.getUniformLocation(prog, 'uBlendGamma');
    this.uGamma = gl.getUniformLocation(prog, 'uGamma');
    this.uBrightness = gl.getUniformLocation(prog, 'uBrightness');
    this.uColorGain = gl.getUniformLocation(prog, 'uColorGain');
    this.uBlackLift = gl.getUniformLocation(prog, 'uBlackLift');

    this.buf = gl.createBuffer()!;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // DOM image/video rows are already top-first + our UVs put v=0 at top → do NOT flip.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.clearColor(0, 0, 0, 1);
  }

  setSize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  private ensureMSAA(w: number, h: number, samples: number): boolean {
    const gl2 = this.gl2;
    if (!gl2 || samples <= 1) return false;
    const max = gl2.getParameter(gl2.MAX_SAMPLES) as number;
    const s = Math.min(samples, max);
    if (this.msW === w && this.msH === h && this.msSamples === s && this.msFBO) return true;
    if (!this.msFBO) this.msFBO = gl2.createFramebuffer();
    if (!this.msColor) this.msColor = gl2.createRenderbuffer();
    gl2.bindRenderbuffer(gl2.RENDERBUFFER, this.msColor);
    gl2.renderbufferStorageMultisample(gl2.RENDERBUFFER, s, gl2.RGBA8, w, h);
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.msFBO);
    gl2.framebufferRenderbuffer(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.RENDERBUFFER, this.msColor);
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
    this.msW = w; this.msH = h; this.msSamples = s;
    return true;
  }

  // Interleaved [clipX, clipY, u*q, v*q, q] mesh for the warp grid (q=1) or corner-pin quad.
  private buildGeometry(o: DrawOpts): Float32Array {
    const push = (out: number[], c: [number, number], u: number, v: number, q: number) => {
      out.push(c[0], c[1], u * q, v * q, q);
    };
    const out: number[] = [];
    if (o.warp && o.warp.points.length === (o.warp.cols + 1) * (o.warp.rows + 1)) {
      const { cols, rows, points } = o.warp;
      const at = (i: number, j: number) => points[j * (cols + 1) + i];
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const p00 = toClip(at(i, j)), p10 = toClip(at(i + 1, j));
          const p11 = toClip(at(i + 1, j + 1)), p01 = toClip(at(i, j + 1));
          const u0 = i / cols, u1 = (i + 1) / cols, v0 = j / rows, v1 = (j + 1) / rows;
          push(out, p00, u0, v0, 1); push(out, p10, u1, v0, 1); push(out, p11, u1, v1, 1);
          push(out, p00, u0, v0, 1); push(out, p11, u1, v1, 1); push(out, p01, u0, v1, 1);
        }
      }
    } else {
      const p = o.cornerPin;
      const [qTl, qTr, qBr, qBl] = cornerQs(p);
      const ctl = toClip(p.tl), ctr = toClip(p.tr), cbr = toClip(p.br), cbl = toClip(p.bl);
      push(out, ctl, 0, 0, qTl); push(out, ctr, 1, 0, qTr); push(out, cbr, 1, 1, qBr);
      push(out, ctl, 0, 0, qTl); push(out, cbr, 1, 1, qBr); push(out, cbl, 0, 1, qBl);
    }
    return new Float32Array(out);
  }

  // Upload a CPU/DOM source (image/video/canvas) and warp it onto the display.
  draw(src: TexImageSource | null, o: DrawOpts): void {
    const gl = this.gl;
    if (!src) { this.warpFromTexture(null, o); return; }
    try {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch { this.warpFromTexture(null, o); return; } // source not decodable this frame
    this.warpFromTexture(this.tex, o);
  }

  private ensureSrcFBO(w: number, h: number): void {
    const gl = this.gl;
    if (this.srcW === w && this.srcH === h && this.srcFBO) return;
    if (!this.srcFBO) this.srcFBO = gl.createFramebuffer();
    if (!this.srcTex) this.srcTex = gl.createTexture();
    if (!this.bgTex) this.bgTex = gl.createTexture();
    if (!this.overlayTex) this.overlayTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.srcTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.srcW = w; this.srcH = h;
  }

  // Composite TRACKING content (bg + blobs + overlay) on the GPU into the source FBO, then warp it.
  drawTracking(t: TrackingOpts, o: DrawOpts): void {
    const gl = this.gl;
    this.ensureSrcFBO(t.srcW, t.srcH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFBO);
    gl.viewport(0, 0, t.srcW, t.srcH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.clearColor(0, 0, 0, 1);
    if (t.bgSource && this.bgTex && blobPass.uploadTexture(gl, this.bgTex, t.bgSource)) {
      blobPass.drawTex(gl, this.bgTex, 1, false, true);
    }
    if (t.trails && t.trails.length) blobPass.drawSolid(gl, t.trails, true);
    blobPass.drawBlobs(gl, t.srcW, t.srcH, t.blobs, true);
    if (t.overlaySource && this.overlayTex && blobPass.uploadTexture(gl, this.overlayTex, t.overlaySource)) {
      blobPass.drawTex(gl, this.overlayTex, 1, true, true);
    }
    this.warpFromTexture(this.srcTex, o);
  }

  // Warp an already-bound-able texture onto the display (corner-pin / Bézier mesh + soft-edge + gamma).
  private warpFromTexture(tex: WebGLTexture | null, o: DrawOpts): void {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    const useMS = this.ensureMSAA(w, h, o.aa ?? 0);
    const target = useMS && this.gl2 ? this.msFBO : null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!tex) { this.resolve(useMS, w, h); return; }

    gl.bindTexture(gl.TEXTURE_2D, tex);
    const data = this.buildGeometry(o);
    const soft = o.softEdge;
    gl.useProgram(this.prog);
    gl.uniform4f(this.uSoft, soft?.left ?? 0, soft?.right ?? 0, soft?.top ?? 0, soft?.bottom ?? 0);
    gl.uniform1f(this.uBlendGamma, Math.max(0.1, soft?.gamma ?? 2.2));
    gl.uniform1f(this.uGamma, Math.max(0.1, o.gamma ?? 1));
    gl.uniform1f(this.uBrightness, Math.max(0, o.brightness ?? 1));
    const cg = o.colorGain ?? [1, 1, 1], bl = o.blackLift ?? [0, 0, 0];
    gl.uniform3f(this.uColorGain, cg[0], cg[1], cg[2]);
    gl.uniform3f(this.uBlackLift, bl[0], bl[1], bl[2]);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 5 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUVQ);
    gl.vertexAttribPointer(this.aUVQ, 3, gl.FLOAT, false, stride, 2 * 4);
    gl.drawArrays(gl.TRIANGLES, 0, data.length / 5);
    // Leave no enabled attrib arrays behind (the blob pass shares this context — a stale array
    // pointing at a smaller buffer would read out of bounds and crash the GPU process).
    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aUVQ);

    this.resolve(useMS, w, h);
  }

  // Resolve the multisampled FBO to the screen (no-op when MSAA is off — we drew direct).
  private resolve(useMS: boolean, w: number, h: number): void {
    const gl2 = this.gl2;
    if (!useMS || !gl2) return;
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, this.msFBO);
    gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, null);
    gl2.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl2.COLOR_BUFFER_BIT, gl2.NEAREST);
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
  }

  // Read back the rendered output as top-down RGBA, downscaled to fit (maxW, maxH), for NDI
  // send. Blits the resolved on-screen framebuffer into a capped FBO (LINEAR downscale + Y-flip
  // so the buffer is top-down — readPixels is bottom-up, NDI expects top-down), then reads it.
  // WebGL2 only; returns null otherwise. Call right after draw() (same frame).
  captureRGBA(maxW: number, maxH: number): { width: number; height: number; data: Uint8Array } | null {
    const gl2 = this.gl2;
    const cw = this.canvas.width, ch = this.canvas.height;
    if (!gl2 || cw === 0 || ch === 0) return null;
    let w = cw, h = ch;
    if (cw > maxW || ch > maxH) {
      const r = Math.min(maxW / cw, maxH / ch);
      w = Math.max(1, Math.round(cw * r));
      h = Math.max(1, Math.round(ch * r));
    }
    if (!this.capFBO) this.capFBO = gl2.createFramebuffer();
    if (this.capW !== w || this.capH !== h) {
      if (!this.capTex) this.capTex = gl2.createTexture();
      gl2.bindTexture(gl2.TEXTURE_2D, this.capTex);
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA8, w, h, 0, gl2.RGBA, gl2.UNSIGNED_BYTE, null);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR);
      gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR);
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, this.capFBO);
      gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, this.capTex, 0);
      gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
      this.capW = w; this.capH = h;
    }
    // READ = default framebuffer (already holds the resolved, single-sample result).
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, null);
    gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, this.capFBO);
    gl2.blitFramebuffer(0, 0, cw, ch, 0, h, w, 0, gl2.COLOR_BUFFER_BIT, gl2.LINEAR); // dstY flipped
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, this.capFBO);
    const data = new Uint8Array(w * h * 4);
    gl2.readPixels(0, 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, data);
    gl2.bindFramebuffer(gl2.READ_FRAMEBUFFER, null);
    gl2.bindFramebuffer(gl2.DRAW_FRAMEBUFFER, null);
    gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
    return { width: w, height: h, data };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buf);
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.prog);
    if (this.msFBO) gl.deleteFramebuffer(this.msFBO);
    if (this.msColor) gl.deleteRenderbuffer(this.msColor);
    if (this.capFBO) gl.deleteFramebuffer(this.capFBO);
    if (this.capTex) gl.deleteTexture(this.capTex);
    if (this.srcFBO) gl.deleteFramebuffer(this.srcFBO);
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.bgTex) gl.deleteTexture(this.bgTex);
    if (this.overlayTex) gl.deleteTexture(this.overlayTex);
  }
}
