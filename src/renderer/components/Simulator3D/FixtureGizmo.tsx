import React, { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { Fixture, Vec3, Euler3 } from '../../types';
import { effectivePos, effectiveRot } from '../../services/led3dLayout';

const DEG = Math.PI / 180;

export interface FixtureTransform { position3D?: Vec3; rotation3D?: Euler3; scale3D?: number }

interface Props {
  /** The whole selection. Empty ⇒ no gizmo. */
  fixtures: Fixture[];
  mode: 'translate' | 'rotate' | 'scale';
  onRecordHistory: () => void;
  /** One call per gesture, carrying every fixture the drag moved. */
  onCommit: (updates: Array<{ id: string } & FixtureTransform>) => void;
}

// The 3D transform gizmo. It moves the WHOLE SELECTION, not just the primary fixture.
//
// It used to take one `Fixture` and commit one id, while the shell handed it only the primary of a
// multi-selection — so an operator could box-select ten heads, group them, see all ten highlighted…
// and then had to move them one at a time. Rigs are built in rows and arcs; that is the wrong unit
// of work.
//
// HOW A MULTI-DRAG IS EXPRESSED. The gizmo anchors at the selection's CENTROID and the drag is read
// as a DELTA off that anchor, which is then applied to every selected fixture:
//   · translate — add the world delta to each position;
//   · rotate    — orbit each position about the centroid AND add the same rotation to each fixture's
//                 own orientation (a rotated row of heads must both swing around and turn);
//   · scale     — scale each fixture's OFFSET from the centroid, spreading or tightening the group.
//                 The per-fixture `scale3D` is left alone: it sizes a fixture's own LED layout, and
//                 multiplying it here would make a row of heads physically bigger when the operator
//                 asked for them to be further apart.
// A single fixture is just the one-element case, so there is no second code path to keep in step.
export const FixtureGizmo: React.FC<Props> = ({ fixtures, mode, onRecordHistory, onCommit }) => {
  const anchor = useMemo(() => new THREE.Group(), []);
  const controls = useRef<any>(null);

  // The selection as it was when the drag STARTED. Deltas are applied to this, never to the live
  // fixtures: reading committed state mid-drag would compound each frame's delta into the next.
  const startRef = useRef<{ pos: THREE.Vector3; rot: THREE.Euler; scale: number; id: string }[]>([]);
  const centroidRef = useRef(new THREE.Vector3());
  const dragging = useRef(false);
  const moved = useRef(false);

  const ids = fixtures.map((f) => f.id).join(',');

  // Park the anchor on the selection centroid whenever the selection (or its transforms) changes.
  // Skipped while dragging — TransformControls owns the anchor then, and resetting it would fight
  // the pointer.
  useEffect(() => {
    if (!fixtures.length || dragging.current) return;
    const c = new THREE.Vector3();
    for (const f of fixtures) c.add(effectivePos(f));
    c.divideScalar(fixtures.length);
    anchor.position.copy(c);
    // A single fixture keeps its own orientation under the gizmo (so a rotate handle starts aligned
    // to the thing being rotated); a multi-selection has no meaningful shared orientation, so the
    // anchor stays world-aligned and rotation is read as a pure delta.
    if (fixtures.length === 1) anchor.rotation.copy(effectiveRot(fixtures[0]));
    else anchor.rotation.set(0, 0, 0);
    anchor.scale.setScalar(1);
  }, [anchor, fixtures, ids]);

  useEffect(() => {
    const c = controls.current;
    if (!c || !fixtures.length) return;

    const onDown = () => {
      moved.current = false;
      dragging.current = true;
      // Snapshot the selection AND the anchor the deltas will be measured from.
      centroidRef.current.copy(anchor.position);
      startRef.current = fixtures.map((f) => ({
        id: f.id,
        pos: effectivePos(f),
        rot: effectiveRot(f),
        scale: f.scale3D && f.scale3D > 0 ? f.scale3D : 1,
      }));
    };

    // Record history on the first real movement, not on grab: TransformControls fires mouseDown even
    // for a click that never drags, and recording there pushed a junk undo entry per click.
    const onChange = () => { if (!moved.current) { moved.current = true; onRecordHistory(); } };

    const onUp = () => {
      dragging.current = false;
      if (!moved.current) return; // a pure click on a handle — nothing to record or commit
      const start = startRef.current;
      const centroid = centroidRef.current;

      const delta = new THREE.Vector3().subVectors(anchor.position, centroid);
      const spread = Math.max(0.001, anchor.scale.x);
      const rotQuat = new THREE.Quaternion().setFromEuler(anchor.rotation);

      const updates = start.map((s) => {
        const out: { id: string } & FixtureTransform = { id: s.id };

        if (mode === 'translate') {
          const p = s.pos.clone().add(delta);
          out.position3D = { x: p.x, y: p.y, z: p.z };
        } else if (mode === 'rotate') {
          // Orbit the position about the centroid…
          const p = s.pos.clone().sub(centroid).applyQuaternion(rotQuat).add(centroid);
          out.position3D = { x: p.x, y: p.y, z: p.z };
          // …and turn the fixture itself by the same amount. Composed as quaternions so a rotation
          // about two axes does not gimbal into something the operator did not ask for.
          const e = new THREE.Euler().setFromQuaternion(
            rotQuat.clone().multiply(new THREE.Quaternion().setFromEuler(s.rot)), 'XYZ',
          );
          out.rotation3D = { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG };
        } else if (start.length === 1) {
          // Scale SPREADS the group; a lone fixture instead scales its own layout, because a
          // one-element "spread" would move nothing and the handle would appear dead.
          out.scale3D = Math.max(0.01, s.scale * spread);
        } else {
          const p = s.pos.clone().sub(centroid).multiplyScalar(spread).add(centroid);
          out.position3D = { x: p.x, y: p.y, z: p.z };
        }
        return out;
      });

      onCommit(updates);
      // Re-park the anchor for the next gesture: the fixtures have moved under it, and a rotate/scale
      // anchor must return to identity or the next drag would start from a stale basis.
      anchor.rotation.set(0, 0, 0);
      anchor.scale.setScalar(1);
    };

    c.addEventListener('mouseDown', onDown);
    c.addEventListener('objectChange', onChange);
    c.addEventListener('mouseUp', onUp);
    return () => {
      c.removeEventListener('mouseDown', onDown);
      c.removeEventListener('objectChange', onChange);
      c.removeEventListener('mouseUp', onUp);
    };
  }, [anchor, fixtures, ids, mode, onCommit, onRecordHistory]);

  if (!fixtures.length) return null;

  return (
    <>
      <primitive object={anchor} />
      <TransformControls ref={controls} object={anchor} mode={mode} size={0.8} />
    </>
  );
};
