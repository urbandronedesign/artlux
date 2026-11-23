// THE 3D VIEW MODEL — which view the 3D viewport shows, and the arithmetic to frame things in it.
//
// plans/3d-workbench.md, Phase 1. This is the RENDERER-INDEPENDENT half (§2 of the plan): plain data and
// plain maths, no three.js and no React, because the r3f Simulator3D that consumes it is deleted by the
// native engine's E4 phase and this file is meant to outlive it. The r3f adapter (Simulator3D's
// ViewController / FrameController) turns it into cameras; an engine adapter will do the same later.
//
// What it holds is CAMERA state, not document state: switching to Top is not an edit, is never an undo
// step, and does not dirty the project. It is per window and per session — the multi-view LAYOUT (Phase 2)
// is what will be remembered per machine.

export type Vec3 = [number, number, number];

export type OrthoView = 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left';
export type ViewKind = 'persp' | OrthoView;

/**
 * Each orthographic view as Rhino/Blender name it, in ArtLux's world: Y is up, the default camera looks
 * from +Z toward the origin, so "Front" is the view from +Z. `dir` points from the target TO the camera;
 * `up` is the screen's up. Top keeps -Z (the far side of the room) at the top of the screen, which is how
 * a plan is read.
 */
export const ORTHO_VIEWS: Record<OrthoView, { label: string; dir: Vec3; up: Vec3 }> = {
  top:    { label: 'Top',    dir: [0, 1, 0],  up: [0, 0, -1] },
  bottom: { label: 'Bottom', dir: [0, -1, 0], up: [0, 0, 1] },
  front:  { label: 'Front',  dir: [0, 0, 1],  up: [0, 1, 0] },
  back:   { label: 'Back',   dir: [0, 0, -1], up: [0, 1, 0] },
  right:  { label: 'Right',  dir: [1, 0, 0],  up: [0, 1, 0] },
  left:   { label: 'Left',   dir: [-1, 0, 0], up: [0, 1, 0] },
};
export const VIEW_ORDER: ViewKind[] = ['persp', 'top', 'front', 'right', 'back', 'left', 'bottom'];
export const viewLabel = (v: ViewKind): string => (v === 'persp' ? 'Perspective' : ORTHO_VIEWS[v].label);
export const isOrtho = (v: ViewKind): v is OrthoView => v !== 'persp';

/**
 * The flat view that looks ALONG a clicked axis end, toward the scene: the +X end puts the camera on +X
 * (Right), +Y → Top, +Z → Front, the negative ends their opposites. The dominant component decides, so a
 * slightly off-axis direction still lands on its view.
 */
export function viewAlong(dir: Vec3): OrthoView {
  const [x, y, z] = dir;
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  if (ay >= ax && ay >= az) return y >= 0 ? 'top' : 'bottom';
  if (ax >= az) return x >= 0 ? 'right' : 'left';
  return z >= 0 ? 'front' : 'back';
}

// ── The current view (one per window) ───────────────────────────────────────────────────────────
let current: ViewKind = 'persp';
const subs = new Set<() => void>();
export const getView = (): ViewKind => current;
export function setView(v: ViewKind): void {
  if (v === current) return;
  current = v;
  subs.forEach((f) => f());
}
export function subscribeView(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }

// ── Framing requests (zoom extents / zoom selected) ─────────────────────────────────────────────
// Asked from outside the canvas (header button, a key); answered inside it, where the scene's bounds are.
export type FrameTarget = 'extents' | 'selected';
let frameHandler: ((t: FrameTarget) => void) | null = null;
export function registerFrameHandler(h: (t: FrameTarget) => void): () => void {
  frameHandler = h;
  return () => { if (frameHandler === h) frameHandler = null; };
}
export const requestFrame = (t: FrameTarget): boolean => { if (!frameHandler) return false; frameHandler(t); return true; };

// ── Display mode (item 6) ───────────────────────────────────────────────────────────────────────
// How the VENUE (models and screens) is drawn. Fixtures, LEDs and beams always draw as they are — the
// point of Wireframe and X-ray is to see the rig through the room, not to change the rig. Per window and
// per session, like the view; in Phase 2 it becomes per viewport.
export type DisplayMode = 'shaded' | 'wireframe' | 'xray';
export const DISPLAY_MODES: DisplayMode[] = ['shaded', 'wireframe', 'xray'];
export const displayLabel = (m: DisplayMode): string => (m === 'shaded' ? 'Shaded' : m === 'wireframe' ? 'Wireframe' : 'X-ray');
let display: DisplayMode = 'shaded';
const displaySubs = new Set<() => void>();
export const getDisplayMode = (): DisplayMode => display;
export function setDisplayMode(m: DisplayMode): void {
  if (m === display) return;
  display = m;
  displaySubs.forEach((f) => f());
}
export const cycleDisplayMode = (): void => setDisplayMode(DISPLAY_MODES[(DISPLAY_MODES.indexOf(display) + 1) % DISPLAY_MODES.length]);
export function subscribeDisplayMode(f: () => void): () => void { displaySubs.add(f); return () => { displaySubs.delete(f); }; }

// ── Poses (named views, item 5) ─────────────────────────────────────────────────────────────────
// A full viewpoint: which view, where the camera orbits around, where it sits, and (flat views) the zoom.
// Captured and applied inside the canvas — the only place the camera is — through this seam, exactly as
// framing is. The document stores these in Scene3D.views (shared/protocol.ts NamedView3D).
export interface Pose3D { kind: ViewKind; target: Vec3; position: Vec3; zoom?: number }
let poseIO: { capture(): Pose3D | null; apply(p: Pose3D): void } | null = null;
export function registerPoseIO(io: { capture(): Pose3D | null; apply(p: Pose3D): void }): () => void {
  poseIO = io;
  return () => { if (poseIO === io) poseIO = null; };
}
/** The live viewpoint, or null when no 3D view is mounted. */
export const capturePose = (): Pose3D | null => poseIO?.capture() ?? null;
/** Go to a saved viewpoint (switches view first if it was taken in another). False when no 3D view. */
export function applyPose(p: Pose3D): boolean {
  if (!poseIO) return false;
  setView(p.kind);
  poseIO.apply(p);
  return true;
}

// ── Framing maths ───────────────────────────────────────────────────────────────────────────────
/** Breathing room around a framed thing: 1 = touching the edges. */
export const FRAME_MARGIN = 1.15;
/** Below this a "thing" is a point (one fixture): frame a sensible patch around it instead of zooming
 *  to infinity. Metres. */
export const MIN_FRAME_RADIUS = 0.5;

/**
 * Distance a PERSPECTIVE camera must sit from a sphere's centre for the sphere to fit the pane.
 * The limiting field of view is the narrower of the vertical one and the horizontal one the aspect gives.
 */
export function perspFitDistance(radius: number, fovYDeg: number, aspect: number): number {
  const r = Math.max(radius, MIN_FRAME_RADIUS) * FRAME_MARGIN;
  const halfY = (fovYDeg * Math.PI) / 360;
  const halfX = Math.atan(Math.tan(halfY) * Math.max(aspect, 1e-3));
  return r / Math.sin(Math.min(halfY, halfX));
}

/**
 * Zoom for an ORTHOGRAPHIC camera whose frustum is the pane in pixels (r3f's convention: left/right/
 * top/bottom = ±size/2, zoom = pixels per world unit) so that a sphere fits the pane.
 */
export function orthoFitZoom(radius: number, widthPx: number, heightPx: number): number {
  const r = Math.max(radius, MIN_FRAME_RADIUS) * FRAME_MARGIN;
  return Math.max(1e-4, Math.min(widthPx, heightPx) / (2 * r));
}

/**
 * The orthographic zoom that shows the same scale a perspective camera shows at its target — so switching
 * Perspective → Top keeps what you were looking at the same size on screen instead of jumping.
 */
export function orthoZoomMatchingPersp(distance: number, fovYDeg: number, heightPx: number): number {
  const visibleHeight = 2 * Math.max(distance, 1e-4) * Math.tan((fovYDeg * Math.PI) / 360);
  return Math.max(1e-4, heightPx / visibleHeight);
}
