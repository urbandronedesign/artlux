import * as THREE from 'three';
import { Fixture } from '../../types';
import { effectivePos, effectiveRot } from '../../services/led3dLayout';
import type { FixtureTransform } from './fixturePreview';

const DEG = Math.PI / 180;

/** Which way an arrow key sends the selection. Screen-derived, world-quantised — see `screenAxes`. */
export type NudgeDir = 'left' | 'right' | 'fwd' | 'back' | 'up' | 'down';

// THE ARROWS FOLLOW YOUR VIEW, BUT LAND ON WORLD AXES.
//
// Two things have to be true at once. "Left" must mean left ON SCREEN, or the operator has to hold the
// room's compass in their head while they orbit — and after half a turn every arrow does the opposite
// of what it says. But a nudge must also stay EXACT: the whole reason to press a key instead of
// dragging is to move 250 mm along the truss, and a camera-relative direction is a diagonal in world
// terms, so a snapped step off it lands 250 mm along nothing at all.
//
// So the camera chooses the axis and the world owns it: take the camera's right and forward vectors,
// flatten them onto the ground plane, and quantise each to the nearest world axis. Left/right is then
// whichever of ±X / ±Z currently points leftish on screen, and it is still exactly that axis. Up/down
// is world Y always — an operator asking for "up" on a rig means the trim height, never the screen.
export function screenAxes(camera: THREE.Camera | null): { right: THREE.Vector3; fwd: THREE.Vector3 } {
  const right = new THREE.Vector3(1, 0, 0);
  const fwd = new THREE.Vector3(0, 0, -1);
  if (!camera) return { right, fwd };   // no viewport registered — the world's own axes are the answer
  camera.updateMatrixWorld();
  const m = camera.matrixWorld;
  quantise(right.setFromMatrixColumn(m, 0));
  // The camera's -Z is its forward; flattened, that is "away from the operator" across the floor.
  quantise(fwd.setFromMatrixColumn(m, 2).negate());
  // A camera looking straight down flattens both to nothing on one axis and would hand back the same
  // axis twice — every arrow key would then move along one line. Fall back to the world's own frame.
  if (right.equals(fwd) || right.lengthSq() === 0 || fwd.lengthSq() === 0) {
    right.set(1, 0, 0); fwd.set(0, 0, -1);
  }
  return { right, fwd };
}

/** Flatten onto the ground plane and snap to the nearest world axis (±X or ±Z). */
function quantise(v: THREE.Vector3): THREE.Vector3 {
  v.y = 0;
  if (Math.abs(v.x) >= Math.abs(v.z)) v.set(Math.sign(v.x) || 1, 0, 0);
  else v.set(0, 0, Math.sign(v.z) || 1);
  return v;
}

/**
 * One key press, as the same kind of update array a gizmo drag commits.
 *
 * In translate mode the selection SHIFTS; in rotate mode the four arrows turn it about the world axes
 * — around Y for left/right and around the screen-right axis for up/down, which is what "tip it away
 * from me" means when you are looking at it. Rotation orbits the group about its own centre exactly
 * as the gizmo does, so a nudge and a drag are the same gesture at different resolutions.
 *
 * Scale mode has no nudge on purpose: the arrows would have to guess WHICH axis, and the numeric
 * Scale (×) fields in the inspector already do that job exactly.
 */
export function nudgeUpdates(
  fixtures: Fixture[],
  dir: NudgeDir,
  step: number,
  mode: 'translate' | 'rotate' | 'scale',
  camera: THREE.Camera | null,
): Array<{ id: string } & FixtureTransform> {
  if (!fixtures.length || mode === 'scale') return [];
  const { right, fwd } = screenAxes(camera);

  if (mode === 'translate') {
    const v = new THREE.Vector3();
    switch (dir) {
      case 'left': v.copy(right).multiplyScalar(-step); break;
      case 'right': v.copy(right).multiplyScalar(step); break;
      case 'fwd': v.copy(fwd).multiplyScalar(step); break;
      case 'back': v.copy(fwd).multiplyScalar(-step); break;
      case 'up': v.set(0, step, 0); break;
      case 'down': v.set(0, -step, 0); break;
    }
    return fixtures.map((f) => {
      const p = effectivePos(f).add(v);
      return { id: f.id, position3D: { x: p.x, y: p.y, z: p.z } };
    });
  }

  // ROTATE. Up/down tips about the screen-right axis; left/right yaws about world up. PageUp/PageDown
  // have no meaning here — there is no third rotation an arrow pair obviously names — so they are
  // ignored rather than given an arbitrary one.
  if (dir === 'up' || dir === 'down') return [];
  const axis = dir === 'left' || dir === 'right' ? new THREE.Vector3(0, 1, 0) : right;
  const sign = dir === 'right' || dir === 'fwd' ? 1 : -1;
  const q = new THREE.Quaternion().setFromAxisAngle(axis, sign * step * DEG);

  const centroid = new THREE.Vector3();
  for (const f of fixtures) centroid.add(effectivePos(f));
  centroid.divideScalar(fixtures.length);

  return fixtures.map((f) => {
    const p = effectivePos(f).sub(centroid).applyQuaternion(q).add(centroid);
    const e = new THREE.Euler().setFromQuaternion(
      q.clone().multiply(new THREE.Quaternion().setFromEuler(effectiveRot(f))), 'XYZ',
    );
    return {
      id: f.id,
      position3D: { x: p.x, y: p.y, z: p.z },
      rotation3D: { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG },
    };
  });
}

/** The step one press moves: the snap grid, or a fine default when snapping is off. Shift ×10, Alt ÷10. */
export function nudgeStep(
  base: number, e: { shiftKey: boolean; altKey: boolean },
): number {
  if (e.shiftKey) return base * 10;
  if (e.altKey) return base / 10;
  return base;
}
