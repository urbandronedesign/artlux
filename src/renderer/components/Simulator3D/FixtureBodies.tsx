import React, { useEffect, useMemo, useRef } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture } from '../../types';
import { effectivePos, effectiveRot, effectiveLayout } from '../../services/led3dLayout';
import { LED_PICK } from './pickPriority';

// The fixture BODY — one slim bar per fixture, behind its LEDs.
//
// WHY THIS EXISTS. Picking a fixture in the 3D view meant hitting one of its 12mm LED spheres: a
// target a couple of pixels across, on a strip drawn over a big venue screen. In practice it could not
// be done. A real LED bar has a housing, and that housing is what an operator aims at — so fixtures now
// have one, and it is the click target.
//
// PERFORMANCE. One InstancedMesh for EVERY fixture body, sharing a single unit-cylinder geometry, with
// each fixture's length/radius/pose baked into its instance matrix — so a rig with hundreds of fixtures
// costs ONE draw call, same as the LEDs themselves. Nothing here is per-fixture React state; the whole
// buffer is rewritten only when a layout actually changes.
//
// It is drawn BEHIND the LED line (offset by its own radius along local -Z), so the LEDs sit on its
// front face and the body never hides the thing you are looking at.

// Shared geometry: a unit cylinder laid along +X (the axis every layout runs along in local space).
// Height 1 and radius 1, so an instance matrix scale of (length, r, r) is the whole sizing story.
const UNIT_BAR = new THREE.CylinderGeometry(1, 1, 1, 10, 1).rotateZ(Math.PI / 2);

const BASE = new THREE.Color('#2a2a2a');   // housing — reads as hardware, not as content
const SELECTED = new THREE.Color('#27b6c4'); // accent: the selection highlight

interface Props {
  fixtures: Fixture[];
  selectedIds: string[];
  onSelectFixture: (id: string) => void;
}

/** Local-space extent of a fixture's LED run: how long the bar is and how fat it should be. */
function barSize(f: Fixture): { length: number; radius: number } {
  const L = effectiveLayout(f);
  const n = Math.max(1, f.ledCount | 0);
  const s = L.ledSpacing;
  if (L.type === 'matrix') {
    const cols = Math.max(1, L.matrixCols), rows = Math.max(1, L.matrixRows);
    // A panel: span the columns, and be as deep as the rows are tall so the proxy wraps the whole grid.
    return { length: cols * s, radius: Math.max(0.02, (rows * s) / 2) };
  }
  if (L.type === 'arc') {
    // The chord of the arc — an approximation, but this is a housing, not a measurement.
    const chord = 2 * L.arcRadius * Math.sin((L.arcAngle * Math.PI) / 360);
    return { length: Math.max(chord, s), radius: Math.max(0.02, s * 0.6) };
  }
  return { length: (n - 1) * s + s, radius: Math.max(0.02, s * 0.6) };
}

export const FixtureBodies: React.FC<Props> = ({ fixtures, selectedIds, onSelectFixture }) => {
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const count = fixtures.length;

  // Rebuild only when something that MOVES or RESIZES a bar changes — not on colour or selection.
  const sig = useMemo(() => JSON.stringify(fixtures.map((f) => ({
    c: f.ledCount, p: f.position3D, r: f.rotation3D, l: f.layout3D, s: f.scale3D,
  }))), [fixtures]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || count === 0) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const off = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const f = fixtures[i];
      const { length, radius } = barSize(f);
      const fs = f.scale3D && f.scale3D > 0 ? f.scale3D : 1;
      const euler = effectiveRot(f);
      q.setFromEuler(euler);
      // Sit the housing behind the LED line, in the fixture's own frame.
      off.set(0, 0, -radius * fs).applyEuler(euler);
      pos.copy(effectivePos(f)).add(off);
      scl.set(length * fs, radius * fs, radius * fs);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Same trap as InstancedLeds: three caches boundingSphere from the first raycast and
    // `needsUpdate` does not invalidate it, so a moved fixture would stop being clickable.
    mesh.computeBoundingSphere();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, count]);

  // Selection tint — per instance, so highlighting costs no extra draw.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || count === 0) return;
    for (let i = 0; i < count; i++) {
      mesh.setColorAt(i, selectedIds.includes(fixtures[i].id) ? SELECTED : BASE);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [fixtures, selectedIds, count]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId == null) return;
    const f = fixtures[e.instanceId];
    if (f) onSelectFixture(f.id);
  };

  if (count === 0) return null;

  return (
    <instancedMesh
      key={count}                                  // remount when the buffer must be resized
      ref={meshRef}
      args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, count]}
      geometry={UNIT_BAR}
      onClick={onClick}
      // Backdrop screens yield to this the same way they yield to the LEDs — see pickPriority.ts.
      userData={{ [LED_PICK]: true }}
    >
      <meshStandardMaterial roughness={0.6} metalness={0.1} toneMapped={false} />
    </instancedMesh>
  );
};
