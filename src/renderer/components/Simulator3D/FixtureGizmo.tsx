import React, { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { Fixture, Vec3, Euler3 } from '../../types';
import { effectivePos, effectiveRot } from '../../services/led3dLayout';

const DEG = Math.PI / 180;

interface Props {
  fixture: Fixture | null;
  mode: 'translate' | 'rotate' | 'scale';
  onRecordHistory: () => void;
  onCommit: (id: string, updates: { position3D?: Vec3; rotation3D?: Euler3; scale3D?: number }) => void;
}

// drei <OrbitControls makeDefault/> is auto-disabled by TransformControls while
// dragging, so no manual orbit toggling is needed.
export const FixtureGizmo: React.FC<Props> = ({ fixture, mode, onRecordHistory, onCommit }) => {
  const anchor = useMemo(() => new THREE.Group(), []);
  const controls = useRef<any>(null);

  // Keep the anchor synced to the fixture's (effective) transform.
  useEffect(() => {
    if (!fixture) return;
    anchor.position.copy(effectivePos(fixture));
    anchor.rotation.copy(effectiveRot(fixture));
    anchor.scale.setScalar(fixture.scale3D && fixture.scale3D > 0 ? fixture.scale3D : 1);
  }, [anchor, fixture]);

  // Record history on the first real drag movement; commit transform at drag end. TransformControls
  // fires mouseDown on GRAB — even a click that never drags — so recording there pushed a junk undo
  // entry per click. Latch on `objectChange` (an actual transform) instead, and skip the commit when
  // nothing moved. Mirrors the Stage drag latch. See plans/timeline-undo.md §5.1/§5.5.
  const moved = useRef(false);
  useEffect(() => {
    const c = controls.current;
    if (!c || !fixture) return;
    const onDown = () => { moved.current = false; };
    const onChange = () => { if (!moved.current) { moved.current = true; onRecordHistory(); } };
    const onUp = () => {
      if (!moved.current) return; // pure click on a handle — nothing to record or commit
      const p = anchor.position, e = anchor.rotation;
      onCommit(fixture.id, {
        position3D: { x: p.x, y: p.y, z: p.z },
        rotation3D: { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG },
        scale3D: Math.max(0.01, anchor.scale.x), // uniform (gizmo scales the layout extent)
      });
    };
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('objectChange', onChange);
    c.addEventListener('mouseUp', onUp);
    return () => {
      c.removeEventListener('mouseDown', onDown);
      c.removeEventListener('objectChange', onChange);
      c.removeEventListener('mouseUp', onUp);
    };
  }, [anchor, fixture, onCommit, onRecordHistory]);

  if (!fixture) return null;

  return (
    <>
      <primitive object={anchor} />
      <TransformControls ref={controls} object={anchor} mode={mode} size={0.8} />
    </>
  );
};
