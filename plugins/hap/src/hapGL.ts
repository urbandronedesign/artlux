import type { HapFrame } from './types';

// GPU decompression for HAP frames. Uploads the raw BC/DXT blocks as a compressed WebGL2
// texture (WEBGL_compressed_texture_s3tc) and draws them to an offscreen canvas — the GPU
// does the decompression, so the renderer only ever moves ~1MB of blocks instead of an 8MB
// RGBA frame. The resulting canvas is a normal drawable (Stage drawImage / createImageBitmap).
// One renderer per consumer key (layer id / surface path) so independent playheads don't clash.

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() {
  // clip space → uv, flipping V so the texture's top row lands at the top of the canvas
  vUv = vec2((aPos.x + 1.0) * 0.5, 1.0 - (aPos.y + 1.0) * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform int uMode; // 0 = direct (DXT1/DXT5), 1 = scaled YCoCg (HapQ)
in vec2 vUv;
out vec4 o;
void main() {
  vec4 c = texture(uTex, vUv);
  if (uMode == 1) {
    float scale = c.b * 31.875 + 1.0;          // (b*255)/8 + 1
    float Co = (c.r * 255.0 - 128.0) / scale;
    float Cg = (c.g * 255.0 - 128.0) / scale;
    float Y = c.a * 255.0;
    o = vec4((Y + Co - Cg) / 255.0, (Y + Cg) / 255.0, (Y - Co - Cg) / 255.0, 1.0);
  } else {
    o = c;
  }
}`;

// A DOM <canvas> here was never displayed — it is a decompression target that gets sampled — so an
// OffscreenCanvas is both the honest type and the one that can exist in a worker when the engine moves
// there. Both are CanvasImageSource, so every consumer takes either unchanged.
//
// HAP is the most show-critical codec in the app, so this keeps two ways back. If OffscreenCanvas or a
// WebGL2 context on it is unavailable, the DOM canvas is used automatically; and a venue can force the
// old path without a rebuild via localStorage['artlux.hapDomCanvas'] = '1', the same per-machine escape
// hatch idiom as artlux.forceWebGL.
export type DecodeCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(): DecodeCanvas {
  let forced = false;
  try { forced = typeof localStorage !== 'undefined' && localStorage.getItem('artlux.hapDomCanvas') === '1'; } catch { /* ignore */ }
  if (!forced && typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(16, 16); } catch { /* fall through to the DOM canvas */ }
  }
  return document.createElement('canvas');
}

class GLRenderer {
  readonly canvas: DecodeCanvas;
  private gl: WebGL2RenderingContext;
  private s3tc: WEBGL_compressed_texture_s3tc | null;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private uMode: WebGLUniformLocation | null;
  private texW = 0; private texH = 0; private texFmt = -1; // current texture storage (for in-place reuse)
  ok = false;

  constructor() {
    this.canvas = makeCanvas();
    let gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl && !(this.canvas instanceof HTMLCanvasElement)) {
      // An OffscreenCanvas that cannot give a WebGL2 context is not a reason to lose HAP. Retry on a
      // DOM canvas before giving up, so the fallback covers "unsupported here", not just "API missing".
      console.warn('[hapGL] no webgl2 on an OffscreenCanvas — falling back to a DOM canvas');
      (this as { canvas: DecodeCanvas }).canvas = document.createElement('canvas');
      gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false }) as WebGL2RenderingContext | null;
    }
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;
    this.s3tc = gl.getExtension('WEBGL_compressed_texture_s3tc');
    if (!this.s3tc) throw new Error('WEBGL_compressed_texture_s3tc unavailable');

    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('hapGL shader: ' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('hapGL link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uMode = gl.getUniformLocation(prog, 'uMode');

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(prog);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
    this.ok = true;
  }

  private glFormat(format: string): number {
    const e = this.s3tc!;
    // DXT5 and YCoCg both ship BC3 blocks; YCoCg is converted in the shader.
    return format === 'dxt1' ? e.COMPRESSED_RGB_S3TC_DXT1_EXT : e.COMPRESSED_RGBA_S3TC_DXT5_EXT;
  }

  upload(f: HapFrame): void {
    const gl = this.gl;
    if (this.canvas.width !== f.width || this.canvas.height !== f.height) {
      this.canvas.width = f.width; this.canvas.height = f.height;
    }
    gl.viewport(0, 0, f.width, f.height);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const fmt = this.glFormat(f.format);
    // Update the texture in place once its storage is allocated — compressedTexSubImage2D reuses
    // the existing GPU allocation, whereas compressedTexImage2D reallocates it every frame (per-
    // frame allocation churn the driver can hitch on). Reallocate only when size/format changes.
    if (this.texW === f.width && this.texH === f.height && this.texFmt === fmt) {
      gl.compressedTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, f.width, f.height, fmt, f.data);
    } else {
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, fmt, f.width, f.height, 0, f.data);
      this.texW = f.width; this.texH = f.height; this.texFmt = fmt;
    }
    gl.useProgram(this.prog);
    gl.uniform1i(this.uMode, f.format === 'ycocg' ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const renderers = new Map<string, GLRenderer | null>(); // null = construction failed (no s3tc)
// Each consumer key (layer id / surface path) gets its own WebGL2 context — one context backs
// exactly one canvas, and simultaneous HAP sources each need their own live canvas. Browsers
// force-lose the oldest context past a hard cap (~16), which would show as black/torn HAP frames,
// so warn once as we approach it rather than fail silently.
const CONTEXT_WARN = 12;
let warnedContexts = false;

// Upload a frame's blocks for `key` and return the canvas showing it (null if WebGL/s3tc
// is unavailable, so the caller can fall back).
export function uploadFrame(key: string, f: HapFrame): DecodeCanvas | null {
  let r = renderers.get(key);
  if (r === undefined) {
    try { r = new GLRenderer(); } catch (e) { console.warn('[hapGL] unavailable:', (e as Error).message); r = null; }
    renderers.set(key, r);
    if (!warnedContexts && [...renderers.values()].filter(Boolean).length >= CONTEXT_WARN) {
      warnedContexts = true;
      console.warn(`[hapGL] ${CONTEXT_WARN}+ simultaneous HAP WebGL contexts — nearing the browser limit; further HAP layers may glitch as contexts are force-lost.`);
    }
  }
  if (!r) return null;
  try { r.upload(f); } catch (e) { console.warn('[hapGL] upload failed:', e); return null; }
  return r.canvas;
}

export function release(key: string): void {
  renderers.get(key)?.dispose();
  renderers.delete(key);
}
