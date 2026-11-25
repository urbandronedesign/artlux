// Stage-side drawable for AUGMENTA surface content: renders the smoothed object markers (+ optional
// background video + calibration/#id overlay) on the GPU into a per-surface WebGL2 canvas and returns
// it as the surface's drawable (composited by the stage, sampled by the mappers). Mirrors the LiDAR
// trackingDrawable / MediaPipe poseDrawable; the projector renders the same content into
// augmentaProjector's source FBO. A minimal 2D fallback is used only when WebGL2 is unavailable.

import type { Surface, SurfaceContent } from '@/types'; // host domain types (transitional; type-only)
import { timeline } from '@/services/timeline';          // host timeline engine (transitional runtime seam)
import type { NativeSource } from '@artlux/sdk/renderer';
import * as augmentaRenderer from './augmentaRenderer';
import * as blobPass from './blobPass';

export function configure(smoothing: number, predictMs: number): void {
  augmentaRenderer.configure(smoothing, predictMs);
}

interface GLSurf { el: HTMLCanvasElement; gl: WebGL2RenderingContext; bgTex: WebGLTexture; overlayTex: WebGLTexture; w: number; h: number }
interface CPUSurf { el: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number }

const glSurfaces = new Map<string, GLSurf | null>(); // null = GL init failed → CPU fallback
const cpuSurfaces = new Map<string, CPUSurf>();
const glFailedAt = new Map<string, number>(); // when GL init last failed — retried, not cached (see getGL)

function getGL(id: string): GLSurf | null {
  // A lost context (GPU-process crash) is rebuilt, and a failed init is retried rather than cached —
  // see lidar-tracking/trackingDrawable getGL, which this mirrors.
  const cur = glSurfaces.get(id);
  if (cur && cur.gl.isContextLost()) { console.warn(`[augmenta] WebGL context lost for ${id} — rebuilding`); glSurfaces.delete(id); }
  else if (cur === null && performance.now() - (glFailedAt.get(id) ?? 0) >= 2000) glSurfaces.delete(id);
  if (glSurfaces.has(id)) return glSurfaces.get(id)!;
  const el = document.createElement('canvas');
  const gl = el.getContext('webgl2', { premultipliedAlpha: true, antialias: true, alpha: true }) as WebGL2RenderingContext | null;
  if (!gl) { glSurfaces.set(id, null); glFailedAt.set(id, performance.now()); return null; }
  const s: GLSurf = { el, gl, bgTex: gl.createTexture()!, overlayTex: gl.createTexture()!, w: 0, h: 0 };
  glSurfaces.set(id, s);
  return s;
}

// Render Augmenta content keyed by an arbitrary consumer key (surface id, or `layer:<id>` for a
// timeline content clip). The renderers read only `content` (+ the key for the canvas map).
export function getFor(key: string, content: SurfaceContent): HTMLCanvasElement | null {
  const now = performance.now();
  const { w, h } = augmentaRenderer.sourceSize();
  const surface = { id: key, content } as Surface;
  const g = getGL(key);
  return g ? renderGL(g, surface, w, h, now) : renderCPU(surface, w, h, now);
}

export function get(surface: Surface): HTMLCanvasElement | null {
  return getFor(surface.id, surface.content);
}

// Drop a consumer's canvases (called when a surface/clip stops needing Augmenta content).
export function release(key: string): void {
  glSurfaces.delete(key);
  cpuSurfaces.delete(key);
  lastFrame.delete(key);
}

function renderGL(g: GLSurf, surface: Surface, w: number, h: number, now: number): HTMLCanvasElement {
  const gl = g.gl;
  if (g.w !== w || g.h !== h) { g.el.width = w; g.el.height = h; g.w = w; g.h = h; }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  const c = surface.content;
  if (c.bgLayerId) {
    const bg = timeline.getLayerDrawable(c.bgLayerId);
    if (bg && blobPass.uploadTexture(gl, g.bgTex, bg as TexImageSource)) blobPass.drawTex(gl, g.bgTex, 1, false, false);
  }
  const trail = c.trail !== false ? augmentaRenderer.trails(surface, now, c.trailSeconds ?? 1.2) : new Float32Array(0);
  if (trail.length) blobPass.drawSolid(gl, trail, false);
  const blobs = augmentaRenderer.instances(surface, now);
  blobPass.drawBlobs(gl, w, h, blobs, false);
  lastFrame.set(surface.id, { blobs, trail });   // E2: what the engine is handed (nativeTickFor)
  const ov = augmentaRenderer.overlayCanvas(surface, w, h);
  if (ov && blobPass.uploadTexture(gl, g.overlayTex, ov)) blobPass.drawTex(gl, g.overlayTex, 1, true, false);
  return g.el;
}

// Minimal 2D fallback (no WebGL2): solid disc per object + bg + overlay. Cheap, rarely used.
function renderCPU(surface: Surface, w: number, h: number, now: number): HTMLCanvasElement {
  let cv = cpuSurfaces.get(surface.id);
  if (!cv) { const el = document.createElement('canvas'); cv = { el, ctx: el.getContext('2d')!, w: 0, h: 0 }; cpuSurfaces.set(surface.id, cv); }
  if (cv.w !== w || cv.h !== h) { cv.el.width = w; cv.el.height = h; cv.w = w; cv.h = h; }
  const ctx = cv.ctx;
  ctx.clearRect(0, 0, w, h);
  const c = surface.content;
  if (c.bgLayerId) { const bg = timeline.getLayerDrawable(c.bgLayerId); if (bg) { try { ctx.drawImage(bg as CanvasImageSource, 0, 0, w, h); } catch { /* */ } } }
  const r = Math.max(2, (c.blobSize ?? 0.04) * h);
  for (const b of augmentaRenderer.instances(surface, now)) {
    ctx.globalAlpha = b.a;
    ctx.fillStyle = `rgb(${b.rgb.map((x) => Math.round(x * 255)).join(',')})`;
    ctx.beginPath(); ctx.arc(b.x * w, b.y * h, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x * w, b.y * h, r * 0.45, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }
  const ov = augmentaRenderer.overlayCanvas(surface, w, h);
  if (ov) ctx.drawImage(ov, 0, 0);
  return cv.el;
}


// ── E2: BLOBS IN THE NATIVE ENGINE (plans/native-engine.md §2 "data H, drawing E") ────────────────────
// The engine draws what THIS draw drew: the instances and trail ribbons renderGL computed this frame are
// kept, and nativeTick hands them over as they are (no second evaluation at another `now`, which would
// move the trails' fade). The engine ports blobPass (engine blobs.rs). What it does not draw stays the
// app's, with the reason: a background timeline layer, and the calibration / id-label overlay (a 2D
// canvas — a setup aid, not show content).
const lastFrame = new Map<string, { blobs: blobPass.BlobInst[]; trail: Float32Array }>();

export function nativeSourceFor(key: string, content: SurfaceContent): NativeSource {
  if (content.bgLayerId) return { kind: 'unsupported', why: 'a Augmenta surface drawn over a timeline layer (composed in the browser)' };
  if (content.calibration || content.showIds) return { kind: 'unsupported', why: 'a Augmenta surface showing its calibration grid or id labels' };
  const { w, h } = augmentaRenderer.sourceSize();
  return { kind: 'blobs', w, h };
}

/** This frame's blobs ([x, y, r, R, G, B, a, heading, dir] each) and trail ([x, y, r, g, b, a] per vertex). */
export function nativeTickFor(key: string): { b: number[]; t: number[] } | undefined {
  const f = lastFrame.get(key);
  if (!f) return undefined;
  const b: number[] = [];
  for (const i of f.blobs) b.push(i.x, i.y, i.r, i.rgb[0], i.rgb[1], i.rgb[2], i.a, i.heading, i.dir);
  return { b, t: Array.from(f.trail) };
}
