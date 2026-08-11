import * as THREE from 'three';
import type { FixtureTransform, GestureSummary } from './fixturePreview';

const DEG = Math.PI / 180;

/**
 * The same gesture, said in the operator's terms — for the header readout.
 *
 * Derived from the anchor and the grab basis, NOT from the per-fixture results: "you have moved this
 * 250 mm" is a property of the drag, and re-deriving it from twelve committed positions would give
 * twelve slightly different answers.
 */
export function gestureSummary(
  start: { length: number }, basis: GizmoBasis, anchor: THREE.Object3D,
  mode: 'translate' | 'rotate' | 'scale',
): GestureSummary {
  const d = new THREE.Vector3().subVectors(anchor.position, basis.centroid);
  const q = anchor.quaternion.clone().multiply(basis.quat.clone().invert()).normalize();
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return {
    mode,
    count: start.length,
    at: { x: anchor.position.x, y: anchor.position.y, z: anchor.position.z },
    delta: { x: d.x, y: d.y, z: d.z },
    turn: { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG },
    factor: {
      x: anchor.scale.x / (basis.scale.x || 1),
      y: anchor.scale.y / (basis.scale.y || 1),
      z: anchor.scale.z / (basis.scale.z || 1),
    },
  };
}

/** One selected fixture as it was when the handle was grabbed. Deltas apply to THIS, never to the
 *  live record — reading committed state mid-drag would compound each frame's delta into the next. */
export interface GizmoStart { id: string; pos: THREE.Vector3; rot: THREE.Euler; scale: THREE.Vector3 }

/** The anchor's own basis at grab time. A gesture is the difference between the anchor now and this. */
export interface GizmoBasis { centroid: THREE.Vector3; quat: THREE.Quaternion; scale: THREE.Vector3 }

// THE TRANSFORM A DRAG MEANS — one function, called from two places that must never disagree: the
// live preview (every `objectChange`, ~pointer rate) and the commit (once, on release). Any drift
// between "what I saw while dragging" and "where it landed" would be a bug the operator can only
// discover by letting go, so there is deliberately no second implementation to keep in step.
//
// HOW A MULTI-DRAG IS EXPRESSED. The gizmo anchors at the selection's CENTROID and the drag is read as
// a DELTA off that anchor, applied to every selected fixture:
//   · translate — add the world delta to each position;
//   · rotate    — orbit each position about the centroid AND add the same rotation to each fixture's
//                 own orientation (a rotated row of heads must both swing around and turn);
//   · scale     — scale each fixture's OFFSET from the centroid, spreading or tightening the group.
//                 The per-fixture `scale3D` is left alone: it sizes a fixture's own LED layout, and
//                 multiplying it here would make a row of heads physically bigger when the operator
//                 asked for them to be further apart.
// A single fixture is just the one-element case, so there is no second code path to keep in step.
export function gizmoDelta(
  start: GizmoStart[],
  basis: GizmoBasis,
  anchor: THREE.Object3D,
  mode: 'translate' | 'rotate' | 'scale',
): Array<{ id: string } & FixtureTransform> {
  const centroid = basis.centroid;
  const delta = new THREE.Vector3().subVectors(anchor.position, centroid);
  // PER AXIS. three drives the three scale handles independently and always in LOCAL space
  // (TransformControls.js:1536 — scale is the one mode whose handles it refuses to world-align), which
  // is exactly the frame a fixture's layout lives in: X along the LED line and the matrix columns, Y
  // across the rows, Z through the housing. Reading only `anchor.scale.x` threw the other two handles
  // away — dragging Y or Z looked like it did nothing, or worse, resized the fixture along its length.
  const spread = new THREE.Vector3(
    Math.max(0.001, anchor.scale.x / (basis.scale.x || 1)),
    Math.max(0.001, anchor.scale.y / (basis.scale.y || 1)),
    Math.max(0.001, anchor.scale.z / (basis.scale.z || 1)),
  );
  // THE ROTATION IS A DELTA — anchorNow · anchorAtGrab⁻¹ — and never the anchor's absolute
  // orientation. It reads like a distinction without a difference because the anchor USUALLY starts at
  // identity, but it does not when the selection is a single fixture: the gizmo parks the anchor on
  // that fixture's own rotation so the handles start aligned to it. Treating that as the delta then
  // multiplied the fixture's rotation onto itself — a bar at yaw 30° dragged by 10° was committed at
  // yaw 70° (verified against three's own composition in TransformControls.js:734-741,
  // `object.quaternion = delta * quaternionStart` in world space). A fixture at yaw 0 is the identity
  // case, which is why this survived: the bug was invisible on exactly the fixtures people test with.
  // Subtracting the start also makes the maths space-agnostic — a local-space anchor legitimately
  // begins rotated, so the delta form is what an object/world toggle has to be built on.
  const invBasis = basis.quat.clone().invert();
  const rotQuat = anchor.quaternion.clone().multiply(invBasis).normalize();

  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();

  return start.map((s) => {
    const out: { id: string } & FixtureTransform = { id: s.id };

    if (mode === 'translate') {
      p.copy(s.pos).add(delta);
      out.position3D = { x: p.x, y: p.y, z: p.z };
    } else if (mode === 'rotate') {
      // Orbit the position about the centroid…
      p.copy(s.pos).sub(centroid).applyQuaternion(rotQuat).add(centroid);
      out.position3D = { x: p.x, y: p.y, z: p.z };
      // …and turn the fixture itself by the same amount. Composed as quaternions so a rotation about
      // two axes does not gimbal into something the operator did not ask for.
      e.setFromQuaternion(rotQuat.clone().multiply(q.setFromEuler(s.rot)), 'XYZ');
      out.rotation3D = { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG };
    } else if (start.length === 1) {
      // Scale SPREADS the group; a lone fixture instead scales its own layout, because a one-element
      // "spread" would move nothing and the handle would appear dead.
      out.scaleXYZ = [
        Math.max(0.01, s.scale.x * spread.x),
        Math.max(0.01, s.scale.y * spread.y),
        Math.max(0.01, s.scale.z * spread.z),
      ];
      // Retire the legacy uniform field on the same write. `effectiveScale3` prefers scaleXYZ, so
      // leaving it would be harmless — and it would also be a second, stale answer to "how big is this
      // fixture" sitting in the project file for someone to read one day. (Undefined does not survive
      // JSON, so this removes it from disk rather than storing a null.)
      out.scale3D = undefined;
    } else {
      // A group spreads per axis too — pulling a row of bars apart along the truss without also
      // lifting them off it is the whole point of having three handles.
      //
      // IN THE ANCHOR'S FRAME, not the world's. Each fixture's offset from the centroid is rotated
      // into the basis the handles were drawn in, scaled there, and rotated back. With a world-aligned
      // anchor both rotations are identity and this is the plain componentwise multiply it looks like;
      // with the gizmo set to Object axes it is the difference between spreading a tilted row ALONG
      // the truss and spreading it along a room axis that merely resembles the truss.
      p.copy(s.pos).sub(centroid)
        .applyQuaternion(invBasis)
        .multiply(spread)
        .applyQuaternion(basis.quat)
        .add(centroid);
      out.position3D = { x: p.x, y: p.y, z: p.z };
    }
    return out;
  });
}
