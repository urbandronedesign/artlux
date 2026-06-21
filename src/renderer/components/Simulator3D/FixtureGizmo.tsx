import React, { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { Fixture, Vec3, Euler3 } from '../../types';
import { effectivePos, effectiveRot } from '../../services/led3dLayout';

const DEG = Math.PI / 180;

interface Props {
  fixture: Fixture | null;
  mode: 'translate' | 'rotate';
  onRecordHistory: () => void;
  onCommit: (id: string, updates: { position3D: Vec3; rotation3D: Euler3 }) => void;
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
  }, [anchor, fixture]);

  // Record history at drag start; commit transform at drag end.
  useEffect(() => {
    const c = controls.current;
    if (!c || !fixture) return;
    const onDown = () => onRecordHistory();
    const onUp = () => {
      const p = anchor.position, e = anchor.rotation;
      onCommit(fixture.id, {
        position3D: { x: p.x, y: p.y, z: p.z },
        rotation3D: { pitch: e.x / DEG, yaw: e.y / DEG, roll: e.z / DEG },
      });
    };
    c.addEventListener('mouseDown', onDown);
    c.addEventListener('mouseUp', onUp);
    return () => {
      c.removeEventListener('mouseDown', onDown);
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
