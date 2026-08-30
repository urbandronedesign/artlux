import React, { useEffect, useMemo, useRef } from 'react';
import { ThreeEvent } from '@react-three/fiber';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture, FixtureProfile } from '../../types';
import { effectivePos, effectiveRot, effectiveScale3 } from '../../services/led3dLayout';
import * as fixtureSignal from '../../services/fixtureSignal';
import { mountShift, rigMetrics } from '../../services/profileRig';
import { isResolvedLight } from '../../services/fixtureKind';
import { LED_PICK } from './pickPriority';
import { livePose } from './fixturePreview';

// PROFILED fixtures in 3D — a base, a yoke and a head, articulated by the fixture's live Pan/Tilt.
//
// A profiled fixture is not a pixel run, so `FixtureBodies` (one bar per fixture, sized from its LED
// layout) draws the wrong thing for it: a moving head has one emitter and a body that MOVES. Without
// this it appears as a stubby 1-LED bar that never turns, which makes the whole 3D view useless for
// checking a focus.
//
// PROCEDURAL, ON PURPOSE. The bundled library comes from the Open Fixture Library, which ships no
// meshes — only physical dimensions. So the body is three boxes sized from `physical.dimsMm`, which
// is enough to read a rig at a glance and to see where a head is pointing. Real GDTF meshes are the
// planned upgrade (docs/FIXTURE-LIBRARY.md); this stays as their permanent fallback, because a rig
// will always contain a fixture nobody has a GDTF for.
//
// PERFORMANCE. Three InstancedMeshes — all bases, all yokes, all heads — so a rig of two hundred
// movers costs three draw calls, not six hundred. The pan/tilt matrices are rewritten per frame from
// the fixture signal, which is why this reads the signal directly rather than going through React.

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
// The HEAD is a barrel, not a box, and that is a legibility decision rather than a cosmetic one: a
// rotating box looks identical from most angles, so a rig of boxes tells you nothing about where
// anything is pointing. A cylinder laid along -Z (the beam axis) reads as an aim direction at a
// glance, which is the entire reason to look at a moving head in 3D before the beams exist.
const UNIT_BARREL = new THREE.CylinderGeometry(1, 1, 1, 12, 1).rotateX(Math.PI / 2);
const BASE_COL = new THREE.Color('#232323');
const YOKE_COL = new THREE.Color('#2e2e2e');
const HEAD_COL = new THREE.Color('#1c1c1c');
const SELECTED = new THREE.Color('#27b6c4');

const DEG = Math.PI / 180;

interface Props {
  fixtures: Fixture[];
  profiles: ReadonlyMap<string, FixtureProfile>;
  selectedIds: string[];
  onSelectFixture: (id: string) => void;
}

/** Body proportions in metres, from the profile's physical size when it declares one. */
function dims(profile: FixtureProfile | undefined) {
  const d = profile?.physical?.dimsMm;
  // A generic mid-size head when the profile is silent — better than nothing, and clearly a fixture.
  const w = d ? Math.max(0.08, d[0] / 1000) : 0.3;
  const h = d ? Math.max(0.08, d[1] / 1000) : 0.45;
  const dp = d ? Math.max(0.08, d[2] / 1000) : 0.28;
  return {
    base: [w, h * 0.30, dp] as const,
    // The yoke is a slim upright the head sits ON, so the two must not occupy the same space —
    // an earlier version overlapped them and the result read as one undifferentiated slab.
    yoke: [w * 0.9, h * 0.40, dp * 0.22] as const,
    // Barrel: radius, radius, LENGTH along the beam axis.
    head: [w * 0.30, w * 0.30, dp * 1.15] as const,
    h,
  };
}

export const MoverBodies: React.FC<Props> = ({ fixtures, profiles, selectedIds, onSelectFixture }) => {
  // Only LIGHT fixtures whose profile resolved; everything else is still a bar in FixtureBodies.
  const movers = useMemo(
    () => fixtures.filter((f) => isResolvedLight(f, profiles)),
    [fixtures, profiles],
  );
  const count = movers.length;

  const baseRef = useRef<THREE.InstancedMesh | null>(null);
  const yokeRef = useRef<THREE.InstancedMesh | null>(null);
  const headRef = useRef<THREE.InstancedMesh | null>(null);

  // Scratch, reused every frame — this runs at display rate and must not allocate.
  const tick = useRef(0);
  const scratch = useMemo(() => ({
    m: new THREE.Matrix4(), q: new THREE.Quaternion(), qp: new THREE.Quaternion(), qt: new THREE.Quaternion(),
    p: new THREE.Vector3(), s: new THREE.Vector3(), off: new THREE.Vector3(), headCol: new THREE.Color(),
    yokeQ: new THREE.Quaternion(), headQ: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0),
  }), []);

  useFrame(() => {
    const b = baseRef.current, y = yokeRef.current, hd = headRef.current;
    if (!b || !y || !hd || !count) return;
    const states = fixtureSignal.snapshot();
    const { m, q, qp, qt, p, s, off, up, right, headCol, yokeQ, headQ } = scratch;

    for (let i = 0; i < count; i++) {
      // The gizmo's live gesture, when one is running — the head follows the handle instead of jumping
      // on release. Free here: this loop already rewrites every matrix from `effectivePos/Rot` each
      // frame for pan/tilt, so previewing is a question of WHICH pose it reads, not extra work.
      const f = livePose(movers[i]);
      const profile = profiles.get(f.profileId!);
      const d = dims(profile);
      // Per-axis in the head's own frame. The STACKING offsets below use the Y component alone,
      // because they walk up the fixture (base → yoke → head) and a body stretched sideways must not
      // pull its own head off the top of its yoke.
      const scale = effectiveScale3(f);
      const st = states.get(f.id);

      // Cached per profile — see services/profileRig. Re-deriving these with two channel scans per
      // fixture per frame cost more than everything else in this loop at 200 movers.
      const rm = profile ? rigMetrics(profile) : { panMid: 0, tiltMid: 0, lensHalf: 7, bodyH: 0.45, lensY: 0.3, lens: { x: 0, y: 0.3, z: 0 } };
      const panMid = rm.panMid, tiltMid = rm.tiltMid;

      // The body is lifted so its MOUNTING FACE sits at position3D — the underside of the base for a
      // floor rig, the top of it for a hung one. Without this a light at Y = 0 is buried to its waist
      // in the floor. One owner: services/profileRig.mountShift, shared with the beam's lens.
      const rootPos = effectivePos(f);
      rootPos.y += mountShift(f.mount, rm, scale.y);
      const rootRot = effectiveRot(f);
      q.setFromEuler(rootRot);

      // BASE — the fixture's own frame, sitting at its origin.
      p.copy(rootPos);
      s.set(d.base[0] * scale.x, d.base[1] * scale.y, d.base[2] * scale.z);
      m.compose(p, q, s);
      b.setMatrixAt(i, m);

      // PAN turns the yoke about the fixture's local UP. Centred so a pan sweep does not translate.
      // The signal is in degrees over the profile's declared range, and 0° is one end of that range,
      // so subtract the mid-point: a head at its centre default must face straight ahead, not
      // sideways. (This is the same "degrees are absolute, not a fraction" property that lets a
      // recorded movement replay on a head with a different sweep.)
      qp.setFromAxisAngle(up, ((st?.pan ?? panMid) - panMid) * DEG);
      yokeQ.copy(q).multiply(qp);

      off.set(0, (d.base[1] * 0.5 + d.yoke[1] * 0.5) * scale.y, 0).applyQuaternion(q);
      p.copy(rootPos).add(off);
      s.set(d.yoke[0] * scale.x, d.yoke[1] * scale.y, d.yoke[2] * scale.z);
      m.compose(p, yokeQ, s);
      y.setMatrixAt(i, m);

      // TILT turns the head about the yoke's local RIGHT, inheriting pan.
      qt.setFromAxisAngle(right, ((st?.tilt ?? tiltMid) - tiltMid) * DEG);
      headQ.copy(yokeQ).multiply(qt);
      // The head pivots at the TOP of the yoke, so a tilt sweeps the barrel about that point rather
      // than about the fixture's base — which is where a real head's trunnion is, and what makes the
      // motion read as a light aiming instead of a box spinning in place.
      off.set(0, (d.base[1] * 0.5 + d.yoke[1]) * scale.y, 0).applyQuaternion(q);
      p.copy(rootPos).add(off);
      s.set(d.head[0] * scale.x, d.head[1] * scale.y, d.head[2] * scale.z);
      m.compose(p, headQ, s);
      hd.setMatrixAt(i, m);

      // The head carries the fixture's OWN emission — its resolved colour scaled by intensity.
      // Until beams exist this is the only way to tell a live fixture from a dark one, and even
      // afterwards it is what makes a rig readable when the haze is off. Deliberately not applied
      // to the base or yoke: housings do not glow, and lighting all three made a selected fixture
      // look lit, which is the one signal this is supposed to reserve for actual output.
      if (st) headCol.setRGB(st.r * st.intensity, st.g * st.intensity, st.b * st.intensity);
      else headCol.copy(HEAD_COL);
      // Never fully black — a head that vanishes into the background reads as a missing fixture
      // rather than an unlit one.
      headCol.lerp(HEAD_COL, 0.15);
      hd.setColorAt(i, headCol);
    }
    if (hd.instanceColor) hd.instanceColor.needsUpdate = true;

    b.instanceMatrix.needsUpdate = true;
    y.instanceMatrix.needsUpdate = true;
    hd.instanceMatrix.needsUpdate = true;
    // three caches boundingSphere from the FIRST raycast and `needsUpdate` does not invalidate it,
    // so a fixture that has since MOVED would stop being clickable. Only the BASE is a pick target,
    // and a base only moves when the operator drags it — never from pan/tilt — so recomputing all
    // three every frame was doing 200-instance walks to keep two non-interactive meshes' bounds
    // fresh. Throttled, and only where a raycast can land.
    if ((tick.current++ & 15) === 0) b.computeBoundingSphere();
  });

  // Selection tint. Only the base carries it: tinting all three made a selected head glow like it
  // was lit, which is exactly the signal the beam is supposed to carry.
  useEffect(() => {
    const b = baseRef.current;
    if (!b || !count) return;
    for (let i = 0; i < count; i++) {
      b.setColorAt(i, selectedIds.includes(movers[i].id) ? SELECTED : BASE_COL);
    }
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
  }, [movers, selectedIds, count]);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId == null) return;
    const f = movers[e.instanceId];
    if (f) onSelectFixture(f.id);
  };

  if (!count) return null;

  const args = (n: number) => [undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, n] as const;

  return (
    <>
      {/* The BASE is the click target — a head that has tilted away is a moving target, the base
          never moves. Same reasoning as FixtureBodies: pick the housing, not the light. */}
      <instancedMesh
        key={`base-${count}`} ref={baseRef} args={args(count) as never} geometry={UNIT_BOX}
        onClick={onClick} userData={{ [LED_PICK]: true }}
      >
        <meshStandardMaterial roughness={0.7} metalness={0.15} toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`yoke-${count}`} ref={yokeRef} args={args(count) as never} geometry={UNIT_BOX}>
        <meshStandardMaterial color={YOKE_COL} roughness={0.65} metalness={0.2} toneMapped={false} />
      </instancedMesh>
      <instancedMesh key={`head-${count}`} ref={headRef} args={args(count) as never} geometry={UNIT_BARREL}>
        {/* No `color` here: the per-instance colour IS the emission, and a material tint would
            multiply it down. Emissive-ish look comes from toneMapped={false} + the bloom pass. */}
        <meshStandardMaterial roughness={0.5} metalness={0.25} toneMapped={false} />
      </instancedMesh>
    </>
  );
};
