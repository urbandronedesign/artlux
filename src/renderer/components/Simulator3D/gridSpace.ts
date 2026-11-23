// THE GRID ON THE VIEW'S PLANE (plans/3d-workbench.md Phase 1, item 7).
//
// The ruler (GroundGrid + GridLabels, solved by gridScale) was written for ONE plane, the floor: it
// intersects the view ray with y = 0, lays lines and numbers on XZ. Seen from Front or Right that floor is
// edge-on — a single line — so a flat side view had no ruler at all.
//
// Rather than teach three files a second and third plane, the grid keeps living in its own LOCAL space,
// where the floor is always y = 0, and that space is ROTATED onto the plane the view looks at:
//   - Simulator3D wraps GroundGrid and GridLabels in a group carrying `gridQuaternion()`;
//   - both solve against `gridCamera(camera)` — the same camera expressed in that local space — so every
//     line of their existing maths is unchanged;
//   - the labels print the WORLD coordinate, which along a rotated axis may be the local one negated
//     (`gridLabelSigns`) — the Front view's vertical run is world height, not "minus local z".
//
// Perspective, Top and Bottom keep the floor: identity (Bottom is the floor seen from below). The origin
// gnomon stays OUTSIDE the rotated group — it marks the world's axes and must never be turned.
//
// The basis per view: local +Y (the grid's "up", the side the numbers are read from) points at the camera
// (the view's `dir`), local −Z points up the screen (the view's `up`) — exactly how the floor sits in Top —
// and local X completes a right-handed frame. So every flat view sees its grid the way Top sees the floor.

import * as THREE from 'three';
import { ORTHO_VIEWS, isOrtho, type ViewKind } from '../../services/view3d';

const quat = new THREE.Quaternion();
const toLocal = new THREE.Matrix4();          // world → grid-local (the inverse rotation)
let identity = true;
const signs = { x: 1, z: 1 };

const _m = new THREE.Matrix4();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

/** Point the grid at the plane `view` looks at. Called by Simulator3D whenever the shown view changes. */
export function setGridPlane(view: ViewKind): void {
  if (!isOrtho(view) || view === 'top') {
    quat.identity(); toLocal.identity(); identity = true; signs.x = 1; signs.z = 1;
    return;
  }
  const v = ORTHO_VIEWS[view];
  _y.set(v.dir[0], v.dir[1], v.dir[2]);
  _z.set(-v.up[0], -v.up[1], -v.up[2]);
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);                    // columns = where local X/Y/Z land in the world
  quat.setFromRotationMatrix(_m);
  toLocal.copy(_m).transpose();                // a rotation's inverse is its transpose
  identity = false;
  // Each run prints the world coordinate along the axis it lies on: the sign of that axis' component.
  const sgn = (w: THREE.Vector3) => Math.sign(w.x + w.y + w.z) || 1;   // exactly one component is ±1
  signs.x = sgn(_x); signs.z = sgn(_z);
}

/** The rotation of the group GroundGrid and GridLabels are drawn in (local → world). */
export const gridQuaternion = (): THREE.Quaternion => quat;
/** What each label run multiplies its local value by to print the world coordinate. */
export const gridLabelSigns = (): { x: number; z: number } => signs;

// A stand-in camera in grid-local space: same projection, world matrix pre-multiplied by the inverse
// rotation. Only the fields the grid maths reads are kept in step (matrixWorld, its inverse, projection).
const proxy = new THREE.Camera();
export function gridCamera(cam: THREE.Camera): THREE.Camera {
  if (identity) return cam;
  proxy.projectionMatrix.copy(cam.projectionMatrix);
  proxy.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
  proxy.matrixWorld.multiplyMatrices(toLocal, cam.matrixWorld);
  proxy.matrixWorldInverse.copy(proxy.matrixWorld).invert();
  proxy.matrixWorld.decompose(proxy.position, proxy.quaternion, proxy.scale);
  return proxy;
}
