// Shared WebGL blob compositor — draws the blob markers (a solid disc + a white direction triangle),
// the comet-trail ribbons, and textured quads (background video + calibration overlay) into the
// currently-bound framebuffer. Used by both the editor stage (its own GL canvas) and the projector
// (rendered straight into ProjectorGL's source FBO). Programs are cached per GL context.
//
// GLSL ES 1.00 (works on WebGL1 + WebGL2). Blob x,y are normalized [0,1] top-left; r is a fraction
// of the framebuffer height. Output is PREMULTIPLIED alpha (blend ONE, 1-SRC_ALPHA). `flipY` inverts
// clip-Y for the projector's source FBO (sampled by the warp with v=0 at top); `uYSign` flips the
// triangle's local Y to match, so the heading is correct on both the stage and the projector.

export interface BlobInst {
  x: number;            // [0,1] left→right
  y: number;            // [0,1] top→bottom
  r: number;            // radius as a fraction of height
  rgb: [number, number, number]; // 0..1
  a: number;            // alpha 0..1
  heading: number;      // radians, screen space (x right, y down) — triangle points this way
  dir: number;          // 0..1 direction strength (triangle fades out when still)
}

// Trail ribbon vertices: flat [x, y, r, g, b, a] with x,y normalized [0,1] and rgba premultiplied.
export type TrailVerts = Float32Array;

type GL = WebGLRenderingContext | WebGL2RenderingContext;

interface Progs {
  blobProg: WebGLProgram; bPos: number; bLocal: number; bColor: number; bAlpha: number; bHeading: number; bDir: number; bYSign: WebGLUniformLocation | null;
  texProg: WebGLProgram; tPos: number; tUV: number; tTex: WebGLUniformLocation | null; tAlpha: WebGLUniformLocation | null; tFlip: WebGLUniformLocation | null;
  solidProg: WebGLProgram; sPos: number; sCol: number; sFlip: WebGLUniformLocation | null;
  blobBuf: WebGLBuffer; quadBuf: WebGLBuffer; solidBuf: WebGLBuffer;
}

const cache = new WeakMap<GL, Progs>();

const BLOB_VERT = `
attribute vec2 aPos; attribute vec2 aLocal; attribute vec3 aColor; attribute float aAlpha;
attribute float aHeading; attribute float aDir;
varying vec2 vLocal; varying vec3 vColor; varying float vAlpha; varying float vHeading; varying float vDir;
void main() { vLocal = aLocal; vColor = aColor; vAlpha = aAlpha; vHeading = aHeading; vDir = aDir; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const BLOB_FRAG = `
precision mediump float;
varying vec2 vLocal; varying vec3 vColor; varying float vAlpha; varying float vHeading; varying float vDir;
uniform float uYSign;
float edge(vec2 p, vec2 a, vec2 b) { vec2 e = b - a; vec2 n = normalize(vec2(-e.y, e.x)); return dot(p - a, n); }
void main() {
  float d = length(vLocal);
  float disc = 1.0 - smoothstep(0.9, 1.0, d);          // solid circle, soft edge
  // screen-space local (x right, y down), rotated so +x points along the heading
  vec2 sl = vec2(vLocal.x, vLocal.y * uYSign);
  float c = cos(vHeading), s = sin(vHeading);
  vec2 p = vec2(c * sl.x + s * sl.y, -s * sl.x + c * sl.y);
  // arrowhead pointing +x, inside the disc; winding-agnostic inside test with AA
  vec2 ta = vec2(0.62, 0.0), tb = vec2(-0.32, 0.42), tc = vec2(-0.32, -0.42);
  float e1 = edge(p, ta, tb), e2 = edge(p, tb, tc), e3 = edge(p, tc, ta);
  float AAW = 0.05;
  float tri = max(smoothstep(-AAW, AAW, min(e1, min(e2, e3))), smoothstep(AAW, -AAW, max(e1, max(e2, e3))));
  vec3 rgb = mix(vColor, vec3(1.0), tri * vDir);        // white triangle, only when moving
  float a = disc * vAlpha;
  gl_FragColor = vec4(rgb * a, a);                      // premultiplied
}`;

const TEX_VERT = `
attribute vec2 aPos; attribute vec2 aUV; varying vec2 vUV; uniform float uFlipY;
void main() { vUV = aUV; gl_Position = vec4(aPos.x, aPos.y * uFlipY, 0.0, 1.0); }`;

const TEX_FRAG = `
precision mediump float;
varying vec2 vUV; uniform sampler2D uTex; uniform float uAlpha;
void main() { vec4 c = texture2D(uTex, vUV); float a = c.a * uAlpha; gl_FragColor = vec4(c.rgb * a, a); }`;

// Solid premultiplied-color triangles (the trail ribbons). Positions are normalized [0,1] top-left.
const SOLID_VERT = `
attribute vec2 aPos; attribute vec4 aCol; varying vec4 vCol; uniform float uFlipY;
void main() {
  float cx = aPos.x * 2.0 - 1.0;
  float cy = (uFlipY > 0.0) ? (aPos.y * 2.0 - 1.0) : (1.0 - aPos.y * 2.0);
  vCol = aCol; gl_Position = vec4(cx, cy, 0.0, 1.0);
}`;
const SOLID_FRAG = `
precision mediump float; varying vec4 vCol;
void main() { gl_FragColor = vCol; }`;

function compile(gl: GL, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`[blobPass] shader: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}
function linkProg(gl: GL, vert: string, frag: string): WebGLProgram {
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
  const blobProg = linkProg(gl, BLOB_VERT, BLOB_FRAG);
  const texProg = linkProg(gl, TEX_VERT, TEX_FRAG);
  const solidProg = linkProg(gl, SOLID_VERT, SOLID_FRAG);
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
    bHeading: gl.getAttribLocation(blobProg, 'aHeading'),
    bDir: gl.getAttribLocation(blobProg, 'aDir'),
    bYSign: gl.getUniformLocation(blobProg, 'uYSign'),
    texProg,
    tPos: gl.getAttribLocation(texProg, 'aPos'),
    tUV: gl.getAttribLocation(texProg, 'aUV'),
    tTex: gl.getUniformLocation(texProg, 'uTex'),
    tAlpha: gl.getUniformLocation(texProg, 'uAlpha'),
    tFlip: gl.getUniformLocation(texProg, 'uFlipY'),
    solidProg,
    sPos: gl.getAttribLocation(solidProg, 'aPos'),
    sCol: gl.getAttribLocation(solidProg, 'aCol'),
    sFlip: gl.getUniformLocation(solidProg, 'uFlipY'),
    blobBuf: gl.createBuffer()!,
    quadBuf,
    solidBuf: gl.createBuffer()!,
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

// Draw the comet-trail ribbons (premultiplied solid triangles) into the bound framebuffer.
export function drawSolid(gl: GL, verts: TrailVerts, flipY: boolean): void {
  if (!verts.length) return;
  const p = progs(gl);
  gl.useProgram(p.solidProg);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform1f(p.sFlip, flipY ? 1 : -1);
  gl.bindBuffer(gl.ARRAY_BUFFER, p.solidBuf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  const stride = 6 * 4;
  gl.enableVertexAttribArray(p.sPos); gl.vertexAttribPointer(p.sPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(p.sCol); gl.vertexAttribPointer(p.sCol, 4, gl.FLOAT, false, stride, 2 * 4);
  gl.drawArrays(gl.TRIANGLES, 0, verts.length / 6);
  gl.disableVertexAttribArray(p.sPos); gl.disableVertexAttribArray(p.sCol);
}

// Draw the blob markers (disc + direction triangle) into the bound framebuffer (size fbW×fbH px).
// Builds one quad per blob (≤64 → a few KB). `flipY` inverts clip-Y for FBO targets sampled by the warp.
export function drawBlobs(gl: GL, fbW: number, fbH: number, blobs: BlobInst[], flipY: boolean): void {
  if (!blobs.length) return;
  const p = progs(gl);
  const FLOATS = 10; // aPos.xy, aLocal.xy, aColor.rgb, aAlpha, aHeading, aDir
  const data = new Float32Array(blobs.length * 6 * FLOATS);
  let o = 0;
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
  for (const b of blobs) {
    const halfPx = b.r * fbH;                       // quad half-size = the circle radius
    const dxC = (halfPx / fbW) * 2, dyC = (halfPx / fbH) * 2;
    const cxC = b.x * 2 - 1, cyC = flipY ? (b.y * 2 - 1) : (1 - b.y * 2);
    for (const [lx, ly] of corners) {
      data[o++] = cxC + lx * dxC; data[o++] = cyC + ly * dyC; // aPos
      data[o++] = lx; data[o++] = ly;                          // aLocal
      data[o++] = b.rgb[0]; data[o++] = b.rgb[1]; data[o++] = b.rgb[2];
      data[o++] = b.a; data[o++] = b.heading; data[o++] = b.dir;
    }
  }
  gl.useProgram(p.blobProg);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform1f(p.bYSign, flipY ? 1 : -1);
  gl.bindBuffer(gl.ARRAY_BUFFER, p.blobBuf);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const stride = FLOATS * 4;
  gl.enableVertexAttribArray(p.bPos); gl.vertexAttribPointer(p.bPos, 2, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(p.bLocal); gl.vertexAttribPointer(p.bLocal, 2, gl.FLOAT, false, stride, 2 * 4);
  gl.enableVertexAttribArray(p.bColor); gl.vertexAttribPointer(p.bColor, 3, gl.FLOAT, false, stride, 4 * 4);
  gl.enableVertexAttribArray(p.bAlpha); gl.vertexAttribPointer(p.bAlpha, 1, gl.FLOAT, false, stride, 7 * 4);
  gl.enableVertexAttribArray(p.bHeading); gl.vertexAttribPointer(p.bHeading, 1, gl.FLOAT, false, stride, 8 * 4);
  gl.enableVertexAttribArray(p.bDir); gl.vertexAttribPointer(p.bDir, 1, gl.FLOAT, false, stride, 9 * 4);
  gl.drawArrays(gl.TRIANGLES, 0, blobs.length * 6);
  gl.disableVertexAttribArray(p.bPos); gl.disableVertexAttribArray(p.bLocal);
  gl.disableVertexAttribArray(p.bColor); gl.disableVertexAttribArray(p.bAlpha);
  gl.disableVertexAttribArray(p.bHeading); gl.disableVertexAttribArray(p.bDir);
}
