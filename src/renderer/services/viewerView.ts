// THE 3D VIEWER CAMERA, AS A PANEL ASKS FOR IT (E5/W5h) — the camera seam's pattern
// (services/cameraAccess.ts). "Bake projected UVs from this view" freezes the editor's 3D viewer camera
// into the model; the viewer is the 3D view's (components/Simulator3D/viewerCamera.ts, three.js), in
// the editor only. The editor installs the real capture (live/editorAccess.ts); a panel window asks the
// editor over the live channel (live/sceneRemote.ts → 'scene3d.captureView').
//
// Async in both, so the Model card has one code path. This module imports nothing that runs.

export type ViewCapture = { view: number[]; eye: [number, number, number] } | null;
let capture: () => Promise<ViewCapture> = async () => null;
export function setViewerCapture(fn: () => Promise<ViewCapture>): void { capture = fn; }
/** The 3D viewer's view-projection and eye NOW — null when no 3D view is open. */
export function captureViewProj(): Promise<ViewCapture> { return capture(); }
