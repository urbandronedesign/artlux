// THE ONE WebGL2 context. Not one per surface — this is the rule the whole plugin is built around.
//
// A browser caps live WebGL contexts (~16 in Chromium) and, past the cap, DROPS THE OLDEST WITHOUT AN
// ERROR. A rig with twenty shader surfaces would silently lose the first ones, with nothing in the log
// and nothing thrown — the operator just sees black surfaces that used to work. The neighbouring
// tracking plugins take one context per consumer (augmentaDrawable.getGL) and get away with it because
// a project has one or two tracking surfaces; shaders are the feature people make twenty of.
//
// So: one context, one program per distinct source text, and per-surface output obtained by rendering
// into this canvas and TRANSFERRING the frame out as an ImageBitmap. The transfer is what makes one
// canvas serve N surfaces — `transferToImageBitmap()` hands over the drawing buffer (no copy) and
// leaves the canvas cleared for the next caller, so each surface walks away with its own picture
// instead of a shared canvas that only ever holds the last one drawn.
//
// An ImageBitmap is a CanvasImageSource, which is exactly what `getDrawable` is contracted to return
// and what `copyExternalImageToTexture` (WebGPUMapper.ts:648) already consumes for every other source.

import { buildProgramSource } from './wrapper';
import { parseHeader, type ShaderInput } from './header';
import { buildPaletteLut } from '@/gpu/palettes'; // host palettes (transitional runtime seam)

export interface CompileResult {
  program: WebGLProgram | null;
  /** Author-space diagnostics: line numbers already translated back out of the wrapper. */
  log: string;
  ok: boolean;
}

interface Uniforms {
  artluxPaletteLut: WebGLUniformLocation | null;
  artluxPaletteRows: WebGLUniformLocation | null;
  iResolution: WebGLUniformLocation | null;
  iTime: WebGLUniformLocation | null;
  iWallTime: WebGLUniformLocation | null;
  iAspect: WebGLUniformLocation | null;
  iFrame: WebGLUniformLocation | null;
}

/** A compiled program plus its uniform locations — what renderToBitmap needs to draw. */
export interface CompiledProgram extends CompileResult {
  uniforms: Uniforms;
  /** Declared inputs, and where each one lives in this program. Empty for a shader with no header. */
  params: { input: ShaderInput; loc: WebGLUniformLocation | null }[];
}

let canvas: OffscreenCanvas | null = null;
let gl: WebGL2RenderingContext | null = null;
let vao: WebGLVertexArrayObject | null = null;
let unavailable = false; // sticky: we said why once, don't spam the log per frame
const programs = new Map<string, CompiledProgram>(); // keyed by author source text
let frameCounter = 0;

/** Lazily stand up the context. Returns null when this machine cannot give us WebGL2 at all. */
function ensure(): WebGL2RenderingContext | null {
  // ASK, don't wait to be told. The event below is the documented way to hear about a lost context,
  // and a lost context is not hypothetical here: the Phase 0 bench killed the GPU process outright
  // (see RENDER_HEIGHTS in shaderDrawable.ts). What that run also showed is the failure MODE — every
  // compile afterwards returned `false` with an EMPTY info log, so a plugin that trusts the event
  // reports "your shader failed to build" and shows nothing to read. `isContextLost()` is a cheap
  // positive check that names the real cause and lets the next frame rebuild from source.
  if (gl && gl.isContextLost()) {
    console.warn('[shader] WebGL context lost — rebuilding');
    programs.clear();
    vao = null;
    gl = null;
    canvas = null;
    paletteLut = null; // its texture belonged to the context that just died
  }
  if (gl) return gl;
  if (unavailable) return null;

  // OffscreenCanvas is required, not preferred: `transferToImageBitmap` is the mechanism that lets one
  // context serve many surfaces, and it exists nowhere else. Chromium has had it for years, so this
  // branch is a guard rather than a real fallback — degrading to a shared HTMLCanvasElement would be
  // worse than nothing, because every shader surface would show whichever one drew last.
  if (typeof OffscreenCanvas === 'undefined') {
    unavailable = true;
    console.warn('[shader] OffscreenCanvas unavailable — shader content disabled');
    return null;
  }

  const c = new OffscreenCanvas(1280, 720);
  // No alpha blending, no depth, no stencil: a generative shader writes every pixel of a full-frame
  // quad. `preserveDrawingBuffer` stays off — transferToImageBitmap takes the buffer anyway.
  const ctx = c.getContext('webgl2', {
    alpha: true, depth: false, stencil: false, antialias: false, premultipliedAlpha: true,
  }) as WebGL2RenderingContext | null;
  if (!ctx) {
    unavailable = true;
    console.warn('[shader] WebGL2 unavailable — shader content disabled');
    return null;
  }

  // A driver reset invalidates every program and buffer we hold. Drop the lot and let the next frame
  // rebuild from source; without this every shader surface stays dead until the app restarts.
  c.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('[shader] WebGL context lost — programs dropped, will rebuild');
    programs.clear();
    vao = null;
    gl = null;
    canvas = null;
    paletteLut = null; // its texture belonged to the context that just died
  });

  canvas = c;
  gl = ctx;
  return gl;
}

/**
 * The fullscreen triangle. A triangle, not a quad: two triangles meeting on the diagonal make the GPU
 * shade that seam twice and can leave a visible hairline; one oversized triangle clipped to the
 * viewport covers the screen with no seam and one fewer vertex.
 */
function ensureGeometry(g: WebGL2RenderingContext): void {
  if (vao) return;
  vao = g.createVertexArray();
  g.bindVertexArray(vao);
  const buf = g.createBuffer();
  g.bindBuffer(g.ARRAY_BUFFER, buf);
  g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
  g.enableVertexAttribArray(0);
  g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
  g.bindVertexArray(null);
}

function compileStage(g: WebGL2RenderingContext, type: number, src: string): { sh: WebGLShader | null; log: string } {
  const sh = g.createShader(type);
  if (!sh) return { sh: null, log: 'could not create shader object' };
  g.shaderSource(sh, src);
  g.compileShader(sh);
  if (g.getShaderParameter(sh, g.COMPILE_STATUS)) return { sh, log: '' };
  const log = g.getShaderInfoLog(sh) ?? 'unknown compile error';
  g.deleteShader(sh);
  return { sh: null, log };
}

/**
 * THE LINE-NUMBER DEBT, paid here.
 *
 * The driver reports errors against the WRAPPED source, which begins with a version line, the uniform
 * block and the Shadertoy adapter. An author who reads "line 47" and looks at line 47 of their own
 * forty-line file is being sent hunting through code that is fine — worse than no line number at all,
 * because it looks authoritative. Every `ERROR: 0:N:` is rewritten to N - prefixLines, the count buildProgramSource reports for THIS shader.
 *
 * Once `#include` resolution lands (Phase 5) the offset stops being a constant and this becomes a real
 * line MAP; the shape of the fix is the same, the arithmetic is not.
 */
function toAuthorSpace(log: string, prefixLines: number): string {
  return log.replace(/(\d+):(\d+)/g, (m, col: string, line: string) => {
    const n = Number(line) - prefixLines;
    return n > 0 ? `${col}:${n}` : m;
  });
}

/** Compile (or return the cached program for) one author source. Never throws. */
export function getProgram(source: string): CompiledProgram {
  const hit = programs.get(source);
  if (hit) return hit;

  const g = ensure();
  if (!g) {
    const miss: CompiledProgram = { program: null, ok: false, log: 'WebGL2 unavailable', uniforms: emptyUniforms(), params: [] };
    return miss; // deliberately NOT cached: a lost context may come back
  }

  const { vert, frag, prefixLines } = buildProgramSource(source);
  const v = compileStage(g, g.VERTEX_SHADER, vert);
  const f = compileStage(g, g.FRAGMENT_SHADER, frag);
  let entry: CompiledProgram;

  if (!v.sh || !f.sh) {
    entry = { program: null, ok: false, log: toAuthorSpace(f.log || v.log, prefixLines), uniforms: emptyUniforms(), params: [] };
  } else {
    const p = g.createProgram()!;
    g.attachShader(p, v.sh);
    g.attachShader(p, f.sh);
    g.bindAttribLocation(p, 0, 'aPos');
    g.linkProgram(p);
    g.deleteShader(v.sh);
    g.deleteShader(f.sh);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) {
      entry = { program: null, ok: false, log: toAuthorSpace(g.getProgramInfoLog(p) ?? 'link failed', prefixLines), uniforms: emptyUniforms(), params: [] };
      g.deleteProgram(p);
    } else {
      entry = {
        program: p, ok: true, log: '',
        uniforms: {
          iResolution: g.getUniformLocation(p, 'iResolution'),
          iTime: g.getUniformLocation(p, 'iTime'),
          iWallTime: g.getUniformLocation(p, 'iWallTime'),
          iAspect: g.getUniformLocation(p, 'iAspect'),
          iFrame: g.getUniformLocation(p, 'iFrame'),
          artluxPaletteLut: g.getUniformLocation(p, 'artluxPaletteLut'),
          artluxPaletteRows: g.getUniformLocation(p, 'artluxPaletteRows'),
        },
        // Where each declared input lives in THIS program. A parameter the shader never reads is
        // optimised out and its location is null — kept in the list anyway, so the inspector still
        // shows the control the author declared rather than silently dropping it.
        params: parseHeader(source).inputs.map((input) => ({ input, loc: g.getUniformLocation(p, input.name) })),
      };
    }
  }

  programs.set(source, entry);
  return entry;
}

/** A "did not build" result carrying `log`. The lint uses it to speak the same language as the driver. */
export function failedProgram(log: string): CompiledProgram {
  return { program: null, ok: false, log, uniforms: emptyUniforms(), params: [] };
}

function emptyUniforms(): Uniforms {
  return { iResolution: null, iTime: null, iWallTime: null, iAspect: null, iFrame: null, artluxPaletteLut: null, artluxPaletteRows: null };
}

/**
 * Render one frame of `entry` at w×h and hand the pixels out as an ImageBitmap.
 *
 * The canvas is resized only when the requested size differs from the last one — a resize reallocates
 * the drawing buffer, so surfaces that share a render size (the common case, since it defaults) cost
 * nothing extra, while a project mixing sizes pays one reallocation per change per frame. Worth
 * measuring before it is worth optimising.
 */
export function renderToBitmap(
  entry: CompiledProgram,
  w: number,
  h: number,
  timeSec: number,
  /** Resolved parameter values by input name — automation override, else authored, else the default. */
  params?: Map<string, number | number[]>,
): ImageBitmap | null {
  const g = ensure();
  if (!g || !entry.ok || !entry.program || !canvas) return null;

  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ensureGeometry(g);

  g.viewport(0, 0, w, h);
  g.useProgram(entry.program);
  const u = entry.uniforms;
  // vec3, matching Shadertoy's own iResolution, so pasted code that reads .z gets the 1.0 it expects.
  if (u.iResolution) g.uniform3f(u.iResolution, w, h, 1);
  if (u.iTime) g.uniform1f(u.iTime, timeSec);
  if (u.iWallTime) g.uniform1f(u.iWallTime, performance.now() / 1000);
  if (u.iAspect) g.uniform1f(u.iAspect, h > 0 ? w / h : 1);
  if (u.iFrame) g.uniform1i(u.iFrame, frameCounter++);

  // ArtLux's own gradients, on texture unit 0, so `palette(id, t)` works in any shader — declared
  // input or a literal id. Uploaded once, lazily: a project with no palette-using shader never pays.
  if (u.artluxPaletteLut) {
    const lut = ensurePaletteLut(g);
    if (lut) {
      g.activeTexture(g.TEXTURE0);
      g.bindTexture(g.TEXTURE_2D, lut.tex);
      g.uniform1i(u.artluxPaletteLut, 0);
      if (u.artluxPaletteRows) g.uniform1i(u.artluxPaletteRows, lut.rows);
    }
  }

  // Declared parameters. A `loc` of null means the shader declared the input and never read it —
  // legitimate, and skipped silently, because the CONTROL still belongs in the inspector.
  for (const { input, loc } of entry.params) {
    if (!loc) continue;
    const v = params?.get(input.name) ?? input.def;
    switch (input.type) {
      case 'color': { const c = Array.isArray(v) ? v : [1, 1, 1, 1]; g.uniform4f(loc, c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1); break; }
      case 'point2D': { const c = Array.isArray(v) ? v : [0.5, 0.5]; g.uniform2f(loc, c[0] ?? 0, c[1] ?? 0); break; }
      case 'bool': g.uniform1i(loc, (typeof v === 'number' ? v : 0) >= 0.5 ? 1 : 0); break;
      case 'long': case 'palette': g.uniform1i(loc, Math.round(typeof v === 'number' ? v : 0)); break;
      default: g.uniform1f(loc, typeof v === 'number' ? v : 0); break;
    }
  }

  g.bindVertexArray(vao);
  g.drawArrays(g.TRIANGLES, 0, 3);
  g.bindVertexArray(null);

  return canvas.transferToImageBitmap();
}

/**
 * ArtLux's gradient palettes as a 256 × N texture, uploaded once.
 *
 * The same LUT the mapper samples for the built-in LED effects (gpu/palettes.ts), so an operator's
 * shader inherits the gradients the rest of the app already uses instead of inventing its own — and a
 * palette becomes an automatable parameter like any other. NEAREST on the row axis because a row IS a
 * palette: interpolating between two of them would blend Ocean into Lava at half a row.
 */
let paletteLut: { tex: WebGLTexture; rows: number } | null = null;

function ensurePaletteLut(g: WebGL2RenderingContext): { tex: WebGLTexture; rows: number } | null {
  if (paletteLut) return paletteLut;
  const lut = buildPaletteLut();
  const tex = g.createTexture();
  if (!tex) return null;
  g.bindTexture(g.TEXTURE_2D, tex);
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 256, lut.count, 0, g.RGBA, g.UNSIGNED_BYTE, lut.data);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  paletteLut = { tex, rows: lut.count };
  return paletteLut;
}

/** For the bench and the boot report: is there a usable context at all? */
export function isAvailable(): boolean {
  return ensure() !== null;
}

/** Drop every compiled program (used on source edits in later phases, and by the context-loss path). */
export function clearPrograms(): void {
  const g = gl;
  if (g) for (const e of programs.values()) if (e.program) g.deleteProgram(e.program);
  programs.clear();
}
