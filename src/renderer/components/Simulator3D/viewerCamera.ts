import * as THREE from 'three';

// The editor viewport's live camera, registered by the Canvas so code OUTSIDE it (the Model
// parameter panel) can capture the current viewpoint — the same module-registry pattern as the
// calibration's registerVenueMesh. The camera object is stable across orbits (three mutates it in
// place), so registration happens once per Canvas life and capture reads fresh matrices at call time.
let viewer: THREE.Camera | null = null;

export function registerViewerCamera(cam: THREE.Camera | null): void {
  viewer = cam;
}

/** The live camera, or null when no 3D viewport is mounted. Used by the arrow-key nudge to decide
 *  which world axis currently points leftish on screen — see nudge.ts. */
export function getViewerCamera(): THREE.Camera | null {
  return viewer;
}

// Snapshot the camera's view-projection matrix (proj * worldInverse) as a plain array, the form
// SceneModel.uvProjView persists — plus WHERE the camera was. Null when no 3D viewport is mounted:
// the caller's button should be inert then, not throw.
//
// THE EYE IS NOT OPTIONAL, and it used to be missing. A "projected from view" bake stored only the
// matrix, so `uvProjEye` stayed absent and the shader read (0,0,0) — the world origin. Both things
// that ask "which way is this face relative to the projector?" then answered against a point that is
// usually inside the venue: Cull back faces culled the wrong half of a mesh unless the camera
// happened to be near the origin, and the occlusion bias would grade its grazing term off the same
// wrong direction. A live projector source never had the bug (resolveProjectedScene supplies both),
// which is exactly why it survived — the frozen bake is the path nobody re-checks.
export function captureViewerViewProj(): { view: number[]; eye: [number, number, number] } | null {
  if (!viewer) return null;
  viewer.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(viewer.projectionMatrix, viewer.matrixWorldInverse);
  const eye = new THREE.Vector3().setFromMatrixPosition(viewer.matrixWorld);
  return { view: vp.toArray(), eye: [eye.x, eye.y, eye.z] };
}
