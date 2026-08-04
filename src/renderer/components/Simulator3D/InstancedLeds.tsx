import React, { useEffect, useMemo, useRef } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { computeLedPositions } from '../../services/led3dLayout';
import { useLedColors } from './hooks/useLedColors';
import { LED_PICK } from './pickPriority';

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
    c: f.ledCount, p: f.position3D, r: f.rotation3D, l: f.layout3D, rev: f.reverse, s: f.scale3D,
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
    // MUST recompute, or the fixtures stop being clickable in the 3D view.
    //
    // THREE.InstancedMesh.raycast() early-outs against `boundingSphere`, which three computes lazily on
    // the FIRST raycast and then caches forever — `instanceMatrix.needsUpdate` does not invalidate it.
    // So the pickable region freezes at whatever the instance positions were the first time anyone
    // clicked, and every later layout change (moving a fixture, editing its 3D position, changing
    // spacing/rows) leaves the ray tested against a sphere that is no longer where the LEDs are.
    //
    // The symptom is exact and was reported as such: picking a fixture in the 3D scene works once, and
    // after that it is impossible. `key={total}` does not save us — it remounts only when the LED COUNT
    // changes, not when positions do.
    mesh.computeBoundingSphere();
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
      // Lets the screens/models yield this click to us when an LED is under the pointer — see
      // pickPriority.ts. Without it a fixture drawn on a screen is unpickable.
      userData={{ [LED_PICK]: true }}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, total]}
      onClick={handleClick}
    >
      {/* 20 triangles per LED, not 80. A UV sphere at 8×6 segments costs 80 triangles and 63 vertices,
          and this mesh is instanced across EVERY LED in the rig — 10k pixels was 800k triangles a frame
          for dots that are 12 mm across. The cost is not only vertex work: sub-pixel triangles are the
          rasterizer's worst case, because each one still shades a 2×2 quad, so the wasted fill scales
          with the triangle COUNT rather than the area covered.
          An icosahedron at detail 0 is 20 faces and 12 vertices, and at this size it is the same dot.
          (A camera-facing quad would be 2 triangles and rounder still, but billboarding needs a custom
          vertex stage — worth doing in TSL when the scene moves to WebGPU, not in GLSL that gets
          deleted then.) */}
      <icosahedronGeometry args={[0.012, 0]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
};

const BLACK = new THREE.Color(0, 0, 0);
