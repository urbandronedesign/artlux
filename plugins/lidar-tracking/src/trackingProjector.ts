// Projector-window GPU render for TRACKING content.
//
// Moved out of the host's ProjectorGL (which no longer imports the plugin): the LiDAR plugin now
// composites its own source texture — background video + comet trails + soft blob discs + #id
// overlay — into the projector's source framebuffer via the projector-channel render hook
// (ProjectorChannel.renderSource). The host still owns the FBO lifecycle and warps the composited
// source through its corner-pin / soft-edge / gamma stage. This is the last LiDAR projector tendril
// inverted (see plugin.renderer.ts where the channel wires these three functions).

import type { Surface } from '@/types';
import type { ProjectorRenderHost } from '@artlux/sdk/renderer';
import * as blobPass from './blobPass';
import * as trackingRenderer from './trackingRenderer';

// The blob-background + overlay textures are per-GL-context: each projector output window owns its
// own WebGL context, so key the texture pair by the context. If we kept a single module-level pair,
// two projector windows would share texture handles from different contexts (invalid → GPU crash).
// The WeakMap entry is collected when the context is (window close), so nothing to dispose here.
const glTex = new WeakMap<WebGLRenderingContext, { bg: WebGLTexture; overlay: WebGLTexture }>();
function texturesFor(gl: WebGLRenderingContext): { bg: WebGLTexture; overlay: WebGLTexture } {
  let t = glTex.get(gl);
  if (!t) { t = { bg: gl.createTexture()!, overlay: gl.createTexture()! }; glTex.set(gl, t); }
  return t;
}

// The source size this surface's tracking content wants, or null when it has no tracking source
// (the host then uses its default draw path — a black self-render, matching the old branch guard).
export function sourceSize(surface: Surface): { w: number; h: number } | null {
  const src = surface.content.trackingSource;
  return src ? trackingRenderer.sourceSize(src) : null;
}

// Push per-output smoothing / prediction from the surface's projector render config (delivered on
// each 'config' message). Mirrors the former ProjectorApp.applyRender → trackingRenderer.configure.
export function configure(render: { trackingSmoothing?: number; trackingPredictMs?: number }): void {
  trackingRenderer.configure(render.trackingSmoothing ?? 0.6, render.trackingPredictMs ?? 50);
}

// Composite the tracking content into the already-bound, (w×h) source framebuffer — background video
// under comet trails under soft blob discs under the optional #id overlay. Mirrors the old
// ProjectorGL.drawTracking body exactly; the host warps the result afterward.
export function renderSource(gl: WebGLRenderingContext, surface: Surface, host: ProjectorRenderHost): void {
  const src = surface.content.trackingSource;
  if (!src) return;
  const { w, h } = trackingRenderer.sourceSize(src);
  const tex = texturesFor(gl);
  const bg = surface.content.bgLayerId ? host.getLayerDrawable(surface.content.bgLayerId) : null;
  if (bg && blobPass.uploadTexture(gl, tex.bg, bg as TexImageSource)) blobPass.drawTex(gl, tex.bg, 1, false, true);
  const trails = surface.content.trail !== false ? trackingRenderer.trails(surface, host.timeMs, surface.content.trailSeconds ?? 1.2) : null;
  if (trails && trails.length) blobPass.drawSolid(gl, trails, true);
  blobPass.drawBlobs(gl, w, h, trackingRenderer.instances(surface, host.timeMs), true);
  const overlay = trackingRenderer.overlayCanvas(surface, w, h);
  if (overlay && blobPass.uploadTexture(gl, tex.overlay, overlay)) blobPass.drawTex(gl, tex.overlay, 1, true, true);
}
