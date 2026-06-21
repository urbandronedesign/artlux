import React, { useEffect, useMemo, useRef } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { computeLedPositions } from '../../services/led3dLayout';
import { useLedColors } from './hooks/useLedColors';

interface Props {
  fixtures: Fixture[];
  onSelectFixture: (id: string) => void;
}

// One InstancedMesh for ALL LEDs across all fixtures. instanceIndex matches the
// cumulative LED order used by the dmxSignal pixel buffer, so color updates need
// no per-fixture bookkeeping.
export const InstancedLeds: React.FC<Props> = ({ fixtures, onSelectFixture }) => {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);

  // Rebuild geometry layout only when something affecting positions changes.
  const layoutSig = useMemo(() => JSON.stringify(fixtures.map(f => ({
    c: f.ledCount, p: f.position3D, r: f.rotation3D, l: f.layout3D, rev: f.reverse,
    x: f.x, y: f.y, w: f.width, h: f.height, rot: f.rotation,
  }))), [fixtures]);

  // Per-instance positions + a global index -> fixtureId map.
  const { positions, total, indexToFixture } = useMemo(() => {
    const arrays: Float32Array[] = [];
    const map: string[] = [];
    let count = 0;
    for (const f of fixtures) {
      const p = computeLedPositions(f);
      arrays.push(p);
      for (let i = 0; i < f.ledCount; i++) map.push(f.id);
      count += f.ledCount;
    }
    const all = new Float32Array(count * 3);
    let o = 0;
    for (const a of arrays) { all.set(a, o); o += a.length; }
    return { positions: all, total: count, indexToFixture: map };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSig]);

  // Apply instance matrices + initialize colors when layout changes.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || total === 0) return;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < total; i++) {
      dummy.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, BLACK);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [positions, total]);

  useLedColors(meshRef, total);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId == null) return;
    const id = indexToFixture[e.instanceId];
    if (id) onSelectFixture(id);
  };

  if (total === 0) return null;

  return (
    <instancedMesh
      key={total}                 // remount when count changes (resizes buffers)
      ref={meshRef}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, total]}
      onClick={handleClick}
    >
      <sphereGeometry args={[0.012, 8, 6]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
};

const BLACK = new THREE.Color(0, 0, 0);
