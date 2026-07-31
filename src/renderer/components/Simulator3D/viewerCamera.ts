import * as THREE from 'three';

// The editor viewport's live camera, registered by the Canvas so code OUTSIDE it (the Model
// parameter panel) can capture the current viewpoint — the same module-registry pattern as the
// calibration's registerVenueMesh. The camera object is stable across orbits (three mutates it in
// place), so registration happens once per Canvas life and capture reads fresh matrices at call time.
let viewer: THREE.Camera | null = null;

export function registerViewerCamera(cam: THREE.Camera | null): void {
  viewer = cam;
}

// Snapshot the camera's view-projection matrix (proj * worldInverse) as a plain array, the form
// SceneModel.uvProjView persists. Null when no 3D viewport is mounted — the caller's button should
// be inert then, not throw.
export function captureViewerViewProj(): number[] | null {
  if (!viewer) return null;
  viewer.updateMatrixWorld(true);
  const vp = new THREE.Matrix4().multiplyMatrices(viewer.projectionMatrix, viewer.matrixWorldInverse);
  return vp.toArray();
}
