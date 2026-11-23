import type * as THREE from 'three';

// How big one screen pixel is in world units, at a given distance from the camera.
//
// The 3D scene has NO fixed scale — a venue is anything from a 20 cm prop to a 40 m arena — so any
// overlay drawn at a constant world size is wrong at every scale but one. Overlays (anchor markers,
// the snap cursor) size themselves in PIXELS through this, exactly like the calibration plugin's
// camera-image markers have always done.
//
// BOTH camera kinds (plans/3d-workbench.md Phase 1): an orthographic view (Top, Front…) has no depth
// scaling at all — a pixel is the same size everywhere — so `distance` is ignored there. The overlays
// used to return early on anything but a perspective camera, which in an ortho view would have frozen
// every marker at whatever size it last had.
export function worldPerPixel(cam: THREE.Camera, heightPx: number, distance: number): number {
  if (!heightPx) return 0;
  const o = cam as THREE.OrthographicCamera;
  if (o.isOrthographicCamera) return (o.top - o.bottom) / Math.max(o.zoom, 1e-6) / heightPx;
  const p = cam as THREE.PerspectiveCamera;
  return (2 * distance * Math.tan((p.fov * Math.PI / 180) / 2)) / heightPx;
}
