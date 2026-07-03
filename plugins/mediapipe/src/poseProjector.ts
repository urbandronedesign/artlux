// Projector-window GPU render for MEDIAPIPE content. The plugin composites its own source texture —
// background video + comet trails + soft person markers + skeleton/#id overlay — into the projector's
// source framebuffer via the projector-channel render hook (ProjectorChannel.renderSource). The host
// owns the FBO lifecycle and warps the composited source through its corner-pin / soft-edge / gamma
// stage. Mirrors the LiDAR trackingProjector.

import type { Surface } from '@/types';
import type { ProjectorRenderHost } from '@artlux/sdk/renderer';
import * as posePass from './posePass';
import * as poseRenderer from './poseRenderer';

// Background + overlay textures are per-GL-context: each projector output window owns its own WebGL
// context, so key the texture pair by the context (a single shared pair would mix handles across
// contexts → GPU crash). The WeakMap entry is collected when the context is (window close).
const glTex = new WeakMap<WebGLRenderingContext, { bg: WebGLTexture; overlay: WebGLTexture }>();
function texturesFor(gl: WebGLRenderingContext): { bg: WebGLTexture; overlay: WebGLTexture } {
  let t = glTex.get(gl);
  if (!t) { t = { bg: gl.createTexture()!, overlay: gl.createTexture()! }; glTex.set(gl, t); }
  return t;
}

// MEDIAPIPE content always self-renders (single camera source), so always return a size — unlike the
// LiDAR channel, there's no per-surface source to gate on.
export function sourceSize(_surface: Surface): { w: number; h: number } | null {
  return poseRenderer.sourceSize();
}

// Push per-output smoothing / prediction from the surface's projector render config.
export function configure(render: { trackingSmoothing?: number; trackingPredictMs?: number }): void {
  poseRenderer.configure(render.trackingSmoothing ?? 0.6, render.trackingPredictMs ?? 50);
}

// Composite the pose content into the already-bound, (w×h) source framebuffer — background video under
// comet trails under soft markers under the optional skeleton/#id overlay. The host warps the result.
export function renderSource(gl: WebGLRenderingContext, surface: Surface, host: ProjectorRenderHost): void {
  const { w, h } = poseRenderer.sourceSize();
  const tex = texturesFor(gl);
  const bg = surface.content.bgLayerId ? host.getLayerDrawable(surface.content.bgLayerId) : null;
  if (bg && posePass.uploadTexture(gl, tex.bg, bg as TexImageSource)) posePass.drawTex(gl, tex.bg, 1, false, true);
  const trails = surface.content.trail !== false ? poseRenderer.trails(surface, host.timeMs, surface.content.trailSeconds ?? 1.2) : null;
  if (trails && trails.length) posePass.drawSolid(gl, trails, true);
  posePass.drawMarkers(gl, w, h, poseRenderer.instances(surface, host.timeMs), true);
  const overlay = poseRenderer.overlayCanvas(surface, w, h);
  if (overlay && posePass.uploadTexture(gl, tex.overlay, overlay)) posePass.drawTex(gl, tex.overlay, 1, true, true);
}
