// Projector-window GPU render for AUGMENTA content. The plugin composites its own source texture —
// background video + comet trails + soft object markers + calibration/#id overlay — into the
// projector's source framebuffer via the projector-channel render hook (ProjectorChannel.renderSource).
// The host owns the FBO lifecycle and warps the composited source through its corner-pin / soft-edge /
// gamma stage. Mirrors the LiDAR trackingProjector / MediaPipe poseProjector.

import type { Surface } from '@/types';
import type { ProjectorRenderHost } from '@artlux/sdk/renderer';
import * as blobPass from './blobPass';
import * as augmentaRenderer from './augmentaRenderer';

// Background + overlay textures are per-GL-context: each projector output window owns its own WebGL
// context, so key the texture pair by the context (a single shared pair would mix handles across
// contexts → GPU crash). The WeakMap entry is collected when the context is (window close).
const glTex = new WeakMap<WebGLRenderingContext, { bg: WebGLTexture; overlay: WebGLTexture }>();
function texturesFor(gl: WebGLRenderingContext): { bg: WebGLTexture; overlay: WebGLTexture } {
  let t = glTex.get(gl);
  if (!t) { t = { bg: gl.createTexture()!, overlay: gl.createTexture()! }; glTex.set(gl, t); }
  return t;
}

// AUGMENTA content always self-renders (single field source), so always return a size — unlike the
// LiDAR channel, there's no per-surface source to gate on.
export function sourceSize(_surface: Surface): { w: number; h: number } | null {
  return augmentaRenderer.sourceSize();
}

// Push per-output smoothing / prediction from the surface's projector render config.
export function configure(render: { trackingSmoothing?: number; trackingPredictMs?: number }): void {
  augmentaRenderer.configure(render.trackingSmoothing ?? 0.6, render.trackingPredictMs ?? 50);
}

// Composite the Augmenta content into the already-bound, (w×h) source framebuffer — background video
// under comet trails under soft markers under the optional calibration/#id overlay. The host warps it.
export function renderSource(gl: WebGLRenderingContext, surface: Surface, host: ProjectorRenderHost): void {
  const { w, h } = augmentaRenderer.sourceSize();
  const tex = texturesFor(gl);
  const bg = surface.content.bgLayerId ? host.getLayerDrawable(surface.content.bgLayerId) : null;
  if (bg && blobPass.uploadTexture(gl, tex.bg, bg as TexImageSource)) blobPass.drawTex(gl, tex.bg, 1, false, true);
  const trails = surface.content.trail !== false ? augmentaRenderer.trails(surface, host.timeMs, surface.content.trailSeconds ?? 1.2) : null;
  if (trails && trails.length) blobPass.drawSolid(gl, trails, true);
  blobPass.drawBlobs(gl, w, h, augmentaRenderer.instances(surface, host.timeMs), true);
  const overlay = augmentaRenderer.overlayCanvas(surface, w, h);
  if (overlay && blobPass.uploadTexture(gl, tex.overlay, overlay)) blobPass.drawTex(gl, tex.overlay, 1, true, true);
}
