import type { CornerPin, WarpGrid, SoftEdge } from '../../../shared/protocol';
import { cornerQs, toClip } from './homography';
import { SOFT_EDGE_GLSL } from './blendGlsl';

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

// The soft-edge ramp itself lives in blendGlsl.ts because the calibrated render path (which draws
// OVER this canvas and so never reaches this shader) has to apply exactly the same one.
const FRAG = `
precision mediump float;
varying vec3 vUVQ;
uniform sampler2D uTex;
uniform vec4 uSoft;        // left, right, top, bottom feather widths (0 = hard)
uniform float uBlendGamma; // THE PROJECTOR'S GAMMA — the ramp is share^(1/g), not share^g.
uniform float uGamma;      // output gamma (1 = off)
uniform float uBrightness; // projector-content master brightness (1 = full)
uniform vec3 uColorGain;   // per-channel white-point/brightness match across projectors (1,1,1 = off)
uniform vec3 uBlackLift;   // per-channel additive black floor to match overlap black (0,0,0 = off)
${SOFT_EDGE_GLSL}
void main() {
  vec2 uv = vUVQ.xy / vUVQ.z;
  vec4 c = texture2D(uTex, uv);
  float pa = blendSignal(softEdgeShare(uv, uSoft), uBlendGamma);
  // Edge blend × per-projector colour gain, plus the black floor where content is attenuated so an
  // overlap's doubled black matches the single-projector black. Identity at gain=1, lift=0.
  c.rgb = c.rgb * pa * uColorGain + uBlackLift * (1.0 - pa);
  c.rgb *= uBrightness;
  c.rgb = pow(max(c.rgb, 0.0), vec3(1.0 / uGamma));
  gl_FragColor = vec4(c.rgb, 1.0);
}`;

// ── THE BAKED-MAP PATH ──────────────────────────────────────────────────────────────────────────
//
// The other way to put content on a venue, and the one a calibration FILE describes.
//
// The mesh path above answers "where on the screen does this corner of my picture go". This one
// answers it per PIXEL, from a map baked by projectorBake.ts and shipped in the .mpcdi: for each
// projector pixel, which texel of the content belongs there.
//
// The map stores the content UV directly, so there is no matrix here and no venue geometry. It used
// to store world positions and resolve them with the model's `uvProjView`, which only works when the
// mesh is in PROJECTED uv mode; a mesh on its own authored UVs has an arbitrary unwrap that no matrix
// recovers, and this path rendered black on exactly that case.
//
// Which is why this exists at all: replaying a calibration used to mean rendering the entire venue a
// second time, from the projector's viewpoint, in its own react-three-fiber scene — measured at
// roughly half this machine's frame rate. With the geometry baked, the same picture costs one
// fullscreen pass and two texture reads, and the show machine needs no venue model at all.
//
// WEBGL2 ONLY: the map is RGBA32F, and the WebGL1 fallback has no float textures. Eight bits per
// channel would give 256 addressable texels across a 1920-wide source — every seam in the venue would
// land on a visibly wrong column. A build that lands on WebGL1 keeps the mesh path, which is what it
// had before this existed.
const VERT_BAKED = `
attribute vec2 aPos;        // clip-space fullscreen triangle pair
varying vec2 vRaster;       // 0..1 across the projector's own raster
void main() {
  vRaster = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_BAKED = `
precision highp float;      // mediump uv would quantise the source to a few hundred texels
varying vec2 vRaster;
uniform sampler2D uTex;     // the content
uniform sampler2D uMap;     // RG = content uv for this projector pixel, A = 1 where geometry was hit
uniform vec4 uSoft;
uniform float uBlendGamma;
uniform float uGamma;
uniform float uBrightness;
uniform vec3 uColorGain;
uniform vec3 uBlackLift;
${SOFT_EDGE_GLSL}
void main() {
  vec4 m = texture2D(uMap, vRaster);
  // A pixel with no content behind it emits BLACK, not the edge of the picture. The bake already
  // folded both reasons into this one flag: no geometry under the pixel, and geometry that fell
  // outside the content's footprint. A projector overshooting the object it maps must go dark, or
  // the surround gets a smear of clamped texels.
  if (m.a < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec4 c = texture2D(uTex, m.rg);
  // ⚠ THE BLEND IS INDEXED IN RASTER SPACE, NOT CONTENT SPACE. A soft edge describes where THIS
  // PROJECTOR's light stops overlapping its neighbour's — a property of the physical footprint. Feed
  // it the content uv and the ramp would slide around with the mapping and stop matching the rig.
  float pa = blendSignal(softEdgeShare(vRaster, uSoft), uBlendGamma);
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
  // Source FBO for GPU-composited plugin content (a plugin draws into srcTex; we warp it → screen)
  private srcFBO: WebGLFramebuffer | null = null;
  private srcTex: WebGLTexture | null = null;
  private srcW = 0; private srcH = 0;
  // Warp-geometry cache. The mesh is a pure function of (cornerPin, warp) and neither changes on a
  // normal frame — only when the operator drags a handle or a new config arrives. Rebuilding it per
  // frame allocated a number[] + a Float32Array and re-uploaded the vertex buffer every draw; with
  // one window per physical output that cost multiplies by the output count. Compared by REFERENCE:
  // both come from refs the projector only reassigns on an actual config/edit change.
  private lastPin: DrawOpts['cornerPin'] | null = null;
  private lastWarp: DrawOpts['warp'] | null = null;
  private lastGeomLen = 0;   // vertex count currently resident in `buf` (0 = nothing uploaded yet)
  // Streamed-frame upload gate. Frames arrive from main at ~30 fps but we draw at display rate, so
  // the same ImageBitmap was re-uploaded via texImage2D on roughly every other frame. The caller
  // passes a generation that ticks per received frame; an unchanged generation means the texture
  // already holds these pixels. undefined = a live drawable (video/canvas) that mutates in place
  // with no generation to compare, so it must always be uploaded.
  private lastSrcGen: number | null = null;

  // ── Baked-map path (WebGL2 only) — built lazily, because most outputs never take it ────────────
  private bakedProg: WebGLProgram | null = null;
  private bakedAPos = -1;
  private bakedU: Record<string, WebGLUniformLocation | null> = {};
  private mapTex: WebGLTexture | null = null;
  private mapW = 0; private mapH = 0;
  private quadBuf: WebGLBuffer | null = null;

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
  //
  // `srcGen` (optional) identifies the pixels in `src`. Pass it for a source that only changes when
  // a new frame is pushed (the ImageBitmap streamed from main) so an unchanged generation skips the
  // texImage2D — at 1080p that is ~8 MB of upload per skipped frame, per output window. Omit it for
  // a live <video>/<canvas> that mutates in place: those must be re-uploaded every frame.
  draw(src: TexImageSource | null, o: DrawOpts, srcGen?: number): void {
    const gl = this.gl;
    if (!src) { this.lastSrcGen = null; this.warpFromTexture(null, o); return; }
    const fresh = srcGen === undefined || srcGen !== this.lastSrcGen || this.lastSrcGen === null;
    if (fresh) {
      try {
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } catch { this.lastSrcGen = null; this.warpFromTexture(null, o); return; } // not decodable this frame
      this.lastSrcGen = srcGen ?? null;
    }
    this.warpFromTexture(this.tex, o);
  }

  /** True once a baked map is resident — the projector can draw from a calibration file. */
  hasBakedMap(): boolean { return !!this.mapTex && this.mapW > 0; }

  /**
   * Upload a baked content-uv map. `uv` is w*h*3 — (u, v, spare) — with NaN where the projector has
   * no content, exactly what comes out of an .mpcdi region whose profile is 2d. Repacked to RGBA32F
   * here, hit flag in alpha.
   *
   * NaN is converted rather than uploaded: a NaN texel compares false against every threshold, so it
   * would pass an `a < 0.5` test on some drivers and fail it on others. Turning "no geometry" into an
   * explicit 0 alpha makes the miss a value rather than a hope.
   *
   * NEAREST filtering, and that is not a quality compromise: neighbouring texels are coordinates on
   * opposite sides of a silhouette, and averaging them samples content from halfway between two
   * unrelated parts of the picture. The same reason the depth map is NEAREST.
   */
  setBakedMap(w: number, h: number, uv: Float32Array): boolean {
    const gl2 = this.gl2;
    if (!gl2) return false;   // WebGL1: no float textures, keep the mesh path
    const gl = this.gl;
    const packed = new Float32Array(w * h * 4);
    for (let i = 0, n = w * h; i < n; i++) {
      const u = uv[i * 3], v = uv[i * 3 + 1];
      const hit = Number.isFinite(u) && Number.isFinite(v);
      packed[i * 4] = hit ? u : 0;
      packed[i * 4 + 1] = hit ? v : 0;
      packed[i * 4 + 2] = 0;
      packed[i * 4 + 3] = hit ? 1 : 0;
    }
    if (!this.mapTex) this.mapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl2.texImage2D(gl.TEXTURE_2D, 0, gl2.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, packed);
    this.mapW = w; this.mapH = h;
    return true;
  }

  clearBakedMap(): void { this.mapW = 0; this.mapH = 0; }

  private ensureBakedProgram(): boolean {
    if (this.bakedProg) return true;
    const gl = this.gl;
    if (!this.gl2) return false;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT_BAKED));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG_BAKED));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('[ProjectorGL] baked link:', gl.getProgramInfoLog(p)); return false; }
    this.bakedProg = p;
    this.bakedAPos = gl.getAttribLocation(p, 'aPos');
    for (const n of ['uTex', 'uMap', 'uSoft', 'uBlendGamma', 'uGamma', 'uBrightness', 'uColorGain', 'uBlackLift']) {
      this.bakedU[n] = gl.getUniformLocation(p, n);
    }
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
    return true;
  }

  /**
   * Draw content through the baked map: one texture read to get this pixel's content coordinate, one
   * to fetch the texel. The map already encodes everything the 3D scene would have computed — the
   * mesh's unwrap or its projection, the occlusion, the footprint edge — so this and the live
   * render-from-projector describe the same picture by construction.
   *
   * Returns false when it could not draw (no WebGL2, no map, no program), so the caller can fall
   * back to the mesh path rather than presenting a blank output.
   */
  drawBaked(src: TexImageSource | null, o: DrawOpts, srcGen?: number): boolean {
    const gl = this.gl;
    if (!this.hasBakedMap() || !this.ensureBakedProgram()) return false;

    if (src) {
      const fresh = srcGen === undefined || srcGen !== this.lastSrcGen || this.lastSrcGen === null;
      if (fresh) {
        try {
          gl.bindTexture(gl.TEXTURE_2D, this.tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
          this.lastSrcGen = srcGen ?? null;
        } catch { this.lastSrcGen = null; }
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.bakedProg);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.bakedU['uTex'] ?? null, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    gl.uniform1i(this.bakedU['uMap'] ?? null, 1);
    gl.activeTexture(gl.TEXTURE0);

    const soft = o.softEdge;
    gl.uniform4f(this.bakedU['uSoft'] ?? null, soft?.left ?? 0, soft?.right ?? 0, soft?.top ?? 0, soft?.bottom ?? 0);
    gl.uniform1f(this.bakedU['uBlendGamma'] ?? null, Math.max(0.1, soft?.gamma ?? 2.2));
    gl.uniform1f(this.bakedU['uGamma'] ?? null, Math.max(0.1, o.gamma ?? 1));
    gl.uniform1f(this.bakedU['uBrightness'] ?? null, Math.max(0, o.brightness ?? 1));
    const cg = o.colorGain ?? [1, 1, 1], bl = o.blackLift ?? [0, 0, 0];
    gl.uniform3f(this.bakedU['uColorGain'] ?? null, cg[0], cg[1], cg[2]);
    gl.uniform3f(this.bakedU['uBlackLift'] ?? null, bl[0], bl[1], bl[2]);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.enableVertexAttribArray(this.bakedAPos);
    gl.vertexAttribPointer(this.bakedAPos, 2, gl.FLOAT, false, 8, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Leave no enabled attrib arrays behind — the mesh path and any plugin blob pass share this
    // context, and a stale array pointing at a smaller buffer reads out of bounds and kills the GPU
    // process. Same rule as warpFromTexture.
    gl.disableVertexAttribArray(this.bakedAPos);
    return true;
  }

  private ensureSrcFBO(w: number, h: number): void {
    const gl = this.gl;
    if (this.srcW === w && this.srcH === h && this.srcFBO) return;
    if (!this.srcFBO) this.srcFBO = gl.createFramebuffer();
    if (!this.srcTex) this.srcTex = gl.createTexture();
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

  // Composite plugin-provided content into the source FBO, then warp it. `composite` draws into the
  // already-bound, (w×h)-sized source framebuffer with raw WebGL (the plugin owns its shaders +
  // textures); the host owns the FBO lifecycle and the warp/soft-edge/gamma resolve. This is the
  // generic seam a ProjectorChannel.renderSource hook drives (e.g. LiDAR tracking) — the host no
  // longer knows what the content is.
  drawComposited(w: number, h: number, composite: (gl: WebGLRenderingContext) => void, o: DrawOpts): void {
    const gl = this.gl;
    this.lastSrcGen = null; // this path warps srcTex, so `tex` is now stale — force the next draw() to upload
    this.ensureSrcFBO(w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcFBO);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.clearColor(0, 0, 0, 1);
    composite(gl);
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
    // Rebuild + re-upload the mesh only when the warp/corner-pin actually changed (reference
    // compare — see lastPin/lastWarp). Uniforms below are cheap and always set; the vertex buffer
    // is the expensive part and its contents persist in `buf` between draws.
    const geomChanged = o.cornerPin !== this.lastPin || o.warp !== this.lastWarp || this.lastGeomLen === 0;
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
    if (geomChanged) {
      const data = this.buildGeometry(o);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
      this.lastGeomLen = data.length;
      this.lastPin = o.cornerPin;
      this.lastWarp = o.warp;
    }
    const stride = 5 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUVQ);
    gl.vertexAttribPointer(this.aUVQ, 3, gl.FLOAT, false, stride, 2 * 4);
    gl.drawArrays(gl.TRIANGLES, 0, this.lastGeomLen / 5);
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
  }
}
