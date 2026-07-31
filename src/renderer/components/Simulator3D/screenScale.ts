import type * as THREE from 'three';

// How big one screen pixel is in world units, at a given distance from a perspective camera.
//
// The 3D scene has NO fixed scale — a venue is anything from a 20 cm prop to a 40 m arena — so any
// overlay drawn at a constant world size is wrong at every scale but one. Overlays (anchor markers,
// the snap cursor) size themselves in PIXELS through this, exactly like the calibration plugin's
// camera-image markers have always done.
export function worldPerPixel(cam: THREE.PerspectiveCamera, heightPx: number, distance: number): number {
  if (!heightPx) return 0;
  return (2 * distance * Math.tan((cam.fov * Math.PI / 180) / 2)) / heightPx;
}
