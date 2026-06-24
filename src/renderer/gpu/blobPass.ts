// Shared WebGL blob compositor — draws soft blob discs (radial-falloff shader) and textured quads
// (background video + calibration overlay) into the currently-bound framebuffer. Used by both the
// editor stage (its own GL canvas) and the projector (rendered straight into ProjectorGL's source
// FBO, so blobs never touch a CPU 2D canvas). Programs are cached per GL context.
//
// GLSL ES 1.00 (works on WebGL1 + WebGL2). Coordinates: blob x,y are normalized [0,1] with a
// top-left origin; r is a fraction of the framebuffer height (so blobs stay round when the FBO
// aspect matches the zone). Output is PREMULTIPLIED alpha (blend ONE, 1-SRC_ALPHA) so the editor's
// premultiplied GL canvas composites correctly over a video, and the projector FBO reads clean.

export interface BlobInst {
  x: number;            // [0,1] left→right
  y: number;            // [0,1] top→bottom
  r: number;            // radius as a fraction of height
  rgb: [number, number, number]; // 0..1
  a: number;            // alpha 0..1
}

type GL = WebGLRenderingContext | WebGL2RenderingContext;

interface Progs {
  blobProg: WebGLProgram; bPos: number; bLocal: number; bColor: number; bAlpha: number;
  texProg: WebGLProgram; tPos: number; tUV: number; tTex: WebGLUniformLocation | null; tAlpha: WebGLUniformLocation | null; tFlip: WebGLUniformLocation | null;
  blobBuf: WebGLBuffer; quadBuf: WebGLBuffer;
}

const cache = new WeakMap<GL, Progs>();

const HALO = 2.2;   // quad half-size = r*HALO (the soft halo extent)

const BLOB_VERT = `
attribute vec2 aPos; attribute vec2 aLocal; attribute vec3 aColor; attribute float aAlpha;
varying vec2 vLocal; varying vec3 vColor; varying float vAlpha;
void main() { vLocal = aLocal; vColor = aColor; vAlpha = aAlpha; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const BLOB_FRAG = `
precision mediump float;
varying vec2 vLocal; varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(vLocal);            // 0 center → 1 at quad edge (= r*HALO)
  float halo = smoothstep(1.0, 0.5, d); // colored soft disc
  float core = smoothstep(0.22, 0.16, d); // bright white centre
  vec3 rgb = mix(vColor, vec3(1.0), core);
  float a = max(halo, core) * vAlpha;
  gl_FragColor = vec4(rgb * a, a); // premultiplied
}`;

const TEX_VERT = `
attribute vec2 aPos; attribute vec2 aUV; varying vec2 vUV; uniform float uFlipY;
void main() { vUV = aUV; gl_Position = vec4(aPos.x, aPos.y * uFlipY, 0.0, 1.0); }`;

const TEX_FRAG = `
precision mediump float;
varying vec2 vUV; uniform sampler2D uTex; uniform float uAlpha;
void main() { vec4 c = texture2D(uTex, vUV); float a = c.a * uAlpha; gl_FragColor = vec4(c.rgb * a, a); }`;

function compile(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`[blobPass] shader: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}
function link(gl: GL, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vert));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, frag));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`[blobPass] link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function progs(gl: GL): Progs {
  let p = cache.get(gl);
  if (p) return p;
  const blobProg = link(gl, BLOB_VERT, BLOB_FRAG);
  const texProg = link(gl, TEX_VERT, TEX_FRAG);
  // Full-screen quad with top-left UV origin (v=0 at clip-top), matching ProjectorGL (no Y flip).
  const quad = new Float32Array([
    -1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1,
    -1, 1, 0, 0, 1, -1, 1, 1, -1, -1, 0, 1,
  ]);
  const quadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  p = {
    blobProg,
    bPos: gl.getAttribLocation(blobProg, 'aPos'),
    bLocal: gl.getAttribLocation(blobProg, 'aLocal'),
    bColor: gl.getAttribLocation(blobProg, 'aColor'),
    bAlpha: gl.getAttribLocation(blobProg, 'aAlpha'),
    texProg,
    tPos: gl.getAttribLocation(texProg, 'aPos'),
    tUV: gl.getAttribLocation(texProg, 'aUV'),
    tTex: gl.getUniformLocation(texProg, 'uTex'),
    tAlpha: gl.getUniformLocation(texProg, 'uAlpha'),
    tFlip: gl.getUniformLocation(texProg, 'uFlipY'),
    blobBuf: gl.createBuffer()!,
    quadBuf,
  };
  cache.set(gl, p);
  return p;
}

// Upload an image source (ImageBitmap / video / canvas) into `tex` for use as a quad texture.
export function uploadTexture(gl: GL, tex: WebGLTexture, src: TexImageSource): boolean {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); return true; }
  catch { return false; } // source not decodable this frame
}

// Draw a full-framebuffer textured quad (background opaque, overlay blended over). `flipY` inverts
// clip-Y for rendering into an FBO that the warp later samples with a v=0-at-top convention.
export function drawTex(gl: GL, tex: WebGLTexture, alpha: number, blend: boolean, flipY: boolean): void {
  const p = progs(gl);
  gl.useProgram(p.texProg);
  if (blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(p.tTex, 0); gl.uniform1f(p.tAlpha, alpha); gl.uniform1f(p.tFlip, flipY ? -1 : 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, p.quadBuf);
  const stride = 4 * 4;
  gl.enableVertexAttribArray(p.tPos); gl.vertexAttribPointer(p.tPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(p.tUV); gl.vertexAttribPointer(p.tUV, 2, gl.FLOAT, false, stride, 2 * 4);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  // Disable our attrib arrays so they don't bleed into the next program's draw (a stale enabled
  // array pointing at a too-small buffer reads out of bounds → GPU process crash).
  gl.disableVertexAttribArray(p.tPos); gl.disableVertexAttribArray(p.tUV);
}

// Draw the blobs as soft discs into the bound framebuffer (size fbW×fbH px). Builds one quad per
// blob (≤64 → a few KB) — no instancing extension needed. `flipY` inverts clip-Y for FBO targets
// sampled by the warp (v=0 at top).
export function drawBlobs(gl: GL, fbW: number, fbH: number, blobs: BlobInst[], flipY: boolean): void {
  if (!blobs.length) return;
  const p = progs(gl);
  const FLOATS = 8; // aPos.xy, aLocal.xy, aColor.rgb, aAlpha
  const data = new Float32Array(blobs.length * 6 * FLOATS);
  let o = 0;
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  for (const b of blobs) {
    const halfPx = b.r * HALO * fbH;
    const dxC = (halfPx / fbW) * 2, dyC = (halfPx / fbH) * 2; // clip-space half-extents (round in px)
    const cxC = b.x * 2 - 1, cyC = flipY ? (b.y * 2 - 1) : (1 - b.y * 2); // center in clip (top-left origin)
    for (const [lx, ly] of corners) {
      data[o++] = cxC + lx * dxC; data[o++] = cyC + ly * dyC; // aPos
      data[o++] = lx; data[o++] = ly;                          // aLocal
      data[o++] = b.rgb[0]; data[o++] = b.rgb[1]; data[o++] = b.rgb[2];
      data[o++] = b.a;
    }
  }
  gl.useProgram(p.blobProg);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindBuffer(gl.ARRAY_BUFFER, p.blobBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const stride = FLOATS * 4;
  gl.enableVertexAttribArray(p.bPos); gl.vertexAttribPointer(p.bPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(p.bLocal); gl.vertexAttribPointer(p.bLocal, 2, gl.FLOAT, false, stride, 2 * 4);
  gl.enableVertexAttribArray(p.bColor); gl.vertexAttribPointer(p.bColor, 3, gl.FLOAT, false, stride, 4 * 4);
  gl.enableVertexAttribArray(p.bAlpha); gl.vertexAttribPointer(p.bAlpha, 1, gl.FLOAT, false, stride, 7 * 4);
  gl.drawArrays(gl.TRIANGLES, 0, blobs.length * 6);
  gl.disableVertexAttribArray(p.bPos); gl.disableVertexAttribArray(p.bLocal);
  gl.disableVertexAttribArray(p.bColor); gl.disableVertexAttribArray(p.bAlpha);
}
