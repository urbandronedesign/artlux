import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Fixture, FixtureProfile } from '../../types';
import { effectivePos, effectiveRot } from '../../services/led3dLayout';
import * as fixtureSignal from '../../services/fixtureSignal';
import { rigMetrics, halfAngle } from '../../services/profileRig';

// TIER 2 of the beam budget: a handful of REAL spotlights, so a beam actually lights the floor and
// the geometry it falls on instead of only being a glowing cone in mid-air.
//
// HARD-CAPPED, and the cap is the whole point. WebGL forward-renders every light for every fragment,
// so lights are not additive in cost terms — they multiply the shading work of the entire scene.
// FixtureLights already learned this the expensive way and caps its point lights at 12, with a
// comment recording that overrunning it makes the driver reset the GL context. This is the same
// budget, spent on the same rig, so the two caps are deliberately small and separate.
//
// WHICH eight? The brightest. A show is read by its strongest beams, and a fixture at 4% adds
// nothing a viewer can see while costing exactly as much as one at 100%. Re-ranked every frame, so
// the lights follow the show rather than the fixture list order.
const MAX_SPOTS = 8;

const DEG = Math.PI / 180;

interface Props {
  fixtures: Fixture[];
  profiles: ReadonlyMap<string, FixtureProfile>;
  /** Scene gain (Scene3D.lightIntensity) so the venue lighting has one master. */
  gain?: number;
}

export const MoverLights: React.FC<Props> = ({ fixtures, profiles, gain = 1 }) => {
  const movers = useMemo(
    () => fixtures.filter((f) => f.profileId && profiles.has(f.profileId)),
    [fixtures, profiles],
  );

  const lightRefs = useRef<(THREE.SpotLight | null)[]>([]);
  const targetRefs = useRef<(THREE.Object3D | null)[]>([]);

  const scratch = useMemo(() => ({
    q: new THREE.Quaternion(), qp: new THREE.Quaternion(), qt: new THREE.Quaternion(),
    dir: new THREE.Vector3(), pos: new THREE.Vector3(), off: new THREE.Vector3(), aim: new THREE.Quaternion(),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0),
  }), []);

  // Ranked once per frame into a reused array — this runs at display rate and must not allocate.
  const ranked = useRef<{ f: Fixture; st: fixtureSignal.FixtureState }[]>([]);

  useFrame(() => {
    const states = fixtureSignal.snapshot();
    const { q, qp, qt, dir, pos, off, up, right, aim } = scratch;

    const list = ranked.current;
    list.length = 0;
    for (const f of movers) {
      const st = states.get(f.id);
      if (st && !st.blackout && st.intensity > 0.01) list.push({ f, st });
    }
    list.sort((a, b) => b.st.intensity - a.st.intensity);

    for (let i = 0; i < MAX_SPOTS; i++) {
      const L = lightRefs.current[i];
      const T = targetRefs.current[i];
      if (!L || !T) continue;
      const entry = list[i];
      if (!entry) { L.intensity = 0; continue; }

      const { f, st } = entry;
      const profile = profiles.get(f.profileId!)!;
      const scale = f.scale3D && f.scale3D > 0 ? f.scale3D : 1;

      const rm = rigMetrics(profile);
      q.setFromEuler(effectiveRot(f));
      qp.setFromAxisAngle(up, (st.pan - rm.panMid) * DEG);
      qt.setFromAxisAngle(right, (st.tilt - rm.tiltMid) * DEG);
      aim.copy(q).multiply(qp).multiply(qt);

      off.set(rm.lens.x * scale, rm.lens.y * scale, rm.lens.z * scale).applyQuaternion(q);
      pos.copy(effectivePos(f)).add(off);

      // Bind the light to its target object here rather than as a prop: the ref is null on the
      // first render, so a prop would wire up a target that does not exist yet and the light would
      // aim at the world origin forever.
      if (L.target !== T) L.target = T;
      L.position.copy(pos);
      // A SpotLight aims at its target object, so the target is parked one metre down the beam.
      dir.set(0, 0, -1).applyQuaternion(aim);
      T.position.copy(pos).addScaledVector(dir, 1);
      T.updateMatrixWorld();

      const half = halfAngle(rm, st.zoomDeg);
      L.angle = Math.min(Math.PI / 2 - 0.01, half * DEG);
      // Penumbra keeps the pool's edge soft, matching the cone's shoulder — a hard-edged pool under
      // a soft-edged beam looks like two different lights.
      L.penumbra = 0.4;
      L.distance = 30;
      L.decay = 1.2;
      L.color.setRGB(st.r, st.g, st.b);
      L.intensity = st.intensity * gain * 14;
    }
  });

  return (
    <>
      {Array.from({ length: MAX_SPOTS }, (_, i) => (
        <React.Fragment key={i}>
          <spotLight ref={(el) => { lightRefs.current[i] = el; }} intensity={0} />
          <object3D ref={(el) => { targetRefs.current[i] = el; }} />
        </React.Fragment>
      ))}
    </>
  );
};

