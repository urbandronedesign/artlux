import type { CornerPin } from '../../../shared/protocol';
import { cornerQs, toClip } from './homography';

// Draws one surface's content as a corner-pinned quad on a black background. The quad's
// four vertices sit at the corner-pin destination points; perspective-correct sampling
// comes from the per-vertex q (see homography.ts).

const VERT = `
attribute vec2 aPos;     // clip-space position
attribute vec3 aUVQ;     // (u*q, v*q, q)
varying vec3 vUVQ;
void main() {
  vUVQ = aUVQ;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
varying vec3 vUVQ;
uniform sampler2D uTex;
void main() {
  vec2 uv = vUVQ.xy / vUVQ.z;
  gl_FragColor = texture2D(uTex, uv);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`[ProjectorGL] shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

export class ProjectorGL {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private tex: WebGLTexture;
  private buf: WebGLBuffer;
  private aPos: number;
  private aUVQ: number;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: true });
    if (!gl) throw new Error('[ProjectorGL] WebGL unavailable');
    this.gl = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`[ProjectorGL] link: ${gl.getProgramInfoLog(prog)}`);
    }
    this.prog = prog;
    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.aUVQ = gl.getAttribLocation(prog, 'aUVQ');

    this.buf = gl.createBuffer()!;
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // DOM image/video sources upload with row 0 = top already; our UVs put v=0 at the
    // top of the quad, so do NOT also flip (that would render upside down).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.clearColor(0, 0, 0, 1);
  }

  // Size the drawing buffer to native device pixels (devicePixelRatio == the display's
  // scaleFactor) so a 4K projector renders crisp rather than upscaled from logical px.
  setSize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  draw(src: TexImageSource | null, pin: CornerPin): void {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!src) return;

    try {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch {
      return; // source not yet decodable this frame
    }

    const [qTl, qTr, qBr, qBl] = cornerQs(pin);
    const ctl = toClip(pin.tl), ctr = toClip(pin.tr), cbr = toClip(pin.br), cbl = toClip(pin.bl);
    // Two triangles (tl, tr, br) + (tl, br, bl). UVs: tl(0,0) tr(1,0) br(1,1) bl(0,1).
    // Each vertex: [clipX, clipY, u*q, v*q, q].
    const v = (c: [number, number], u: number, w: number, q: number) => [c[0], c[1], u * q, w * q, q];
    const data = new Float32Array([
      ...v(ctl, 0, 0, qTl), ...v(ctr, 1, 0, qTr), ...v(cbr, 1, 1, qBr),
      ...v(ctl, 0, 0, qTl), ...v(cbr, 1, 1, qBr), ...v(cbl, 0, 1, qBl),
    ]);

    gl.useProgram(this.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    const stride = 5 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUVQ);
    gl.vertexAttribPointer(this.aUVQ, 3, gl.FLOAT, false, stride, 2 * 4);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.buf);
    gl.deleteTexture(this.tex);
    gl.deleteProgram(this.prog);
  }
}
