import * as THREE from 'three';
import { SceneModel, modelScaleXYZ } from '../../../../shared/protocol';

// How a SceneModel's GLB is placed into world space — the ONE definition, because three different
// things place the same mesh and they must land in byte-identical world coordinates:
//
//   1. ModelObject (this folder)                — what the operator sees and drags in the 3D scene.
//   2. calibration's ProjectorScene             — render-from-projector, drawn from the recovered pose.
//   3. calibration's headless venue registrar   — the raycast target in --broadcast, where (1) never
//                                                 mounts and there is no viewport at all.
//
// (1) and (3) are what the markerless solver RAYCASTS to turn a camera pixel into a 3D venue point,
// and (2) is what actually gets projected onto the real surface. A disagreement between them is not a
// visual glitch — it is a silent metric error: the calibration solves correctly against a world that
// is a few centimetres away from the one being drawn, every RMS reads green, and the picture lands
// off the wall. That failure is nearly undiagnosable from the symptom, which is why this is shared
// rather than "obviously the same three lines" in three files (it was, in two, and drifting).

const DEG = Math.PI / 180;

// Clone a loaded GLB scene and recentre it on its own bounding-box centre, so the returned object's
// origin is the mesh's centre rather than whatever origin the GLB was authored around. Clones share
// geometry + materials with the source, so placing the same file many times stays cheap.
//
// Culling is disabled on every child: a venue mesh is routinely viewed from inside or from a very
// oblique projector pose, where three's frustum test drops parts of the geometry that are genuinely
// on screen — and a raycast against a culled mesh still works, so the editor and the solver would
// disagree about what exists.
export function recenterClone(scene: THREE.Object3D): THREE.Object3D {
  const c = scene.clone(true);
  c.traverse((o) => { o.frustumCulled = false; });
  const center = new THREE.Box3().setFromObject(c).getCenter(new THREE.Vector3());
  c.position.sub(center);
  return c;
}

// Apply a model record's transform to its container. Kept separate from recenterClone because
// ModelObject's container must be STABLE across re-renders (TransformControls attaches to it), so it
// re-applies the transform in place instead of rebuilding the object.
export function applyModelTransform(obj: THREE.Object3D, model: SceneModel): void {
  const [sx, sy, sz] = modelScaleXYZ(model);
  obj.position.set(model.position.x, model.position.y, model.position.z);
  obj.rotation.set(model.rotation.x * DEG, model.rotation.y * DEG, model.rotation.z * DEG);
  obj.scale.set(sx, sy, sz);
}

// Both halves at once: a placed, world-space container ready to render or to raycast. For callers
// that do not need a stable container identity (ProjectorScene, the headless registrar).
export function buildPlacedModel(scene: THREE.Object3D, model: SceneModel): THREE.Group {
  const g = new THREE.Group();
  g.add(recenterClone(scene));
  applyModelTransform(g, model);
  return g;
}
