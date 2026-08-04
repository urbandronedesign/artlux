import React, { useMemo } from 'react';
import * as THREE from 'three';
import type { ProjectorCalibration } from '../../../../shared/protocol';
import { frustumCorners, cameraCenter } from '@artlux/plugin-calibration/renderer';

// Draws the recovered virtual projector's frustum in the 3D scene: optical center + the four
// image-corner rays + the far rectangle. A correctly-solved pose puts the apex at the real projector's
// position and the frustum spanning the projection — the visual accuracy gate for Phase 3. Optional
// markers show the operator's pose-pick world points.
export const ProjectorFrustum: React.FC<{
  calibration: ProjectorCalibration;
  depth?: number;
  color?: string;
  picks?: Array<{ world: [number, number, number] }>;
}> = ({ calibration, depth, color = '#00ffaa', picks }) => {
  const { center, corners } = useMemo(() => {
    // The drawn cone must REACH the venue, or the operator reads a good solve as a wrong one (a fixed
    // 3 m stopped short of any projector standing farther back). Its one known target is the set of
    // pose picks — world points the projector demonstrably lights — so extend just past the farthest.
    let d = depth;
    if (d == null) {
      const C = cameraCenter(calibration.rotation, calibration.translation as [number, number, number]);
      const far = (calibration.posePicks ?? []).reduce(
        (m, p) => Math.max(m, Math.hypot(p.world[0] - C[0], p.world[1] - C[1], p.world[2] - C[2])), 0);
      d = far > 0 ? far * 1.15 : 3;
    }
    return frustumCorners(calibration.intrinsics, calibration.rotation, calibration.translation as [number, number, number], calibration.imageSize, d);
  }, [calibration, depth]);
  const C = new THREE.Vector3(...center);
  const cs = corners.map(c => new THREE.Vector3(...c));

  // ONE LineSegments for all eight edges, not eight drei <Line>s.
  //
  // drei's Line is a fat-line (Line2/LineMaterial) and that has two costs here. It is a mesh per line,
  // so a frustum was eight draw calls and a rig of three projectors twenty-four; and LineMaterial is a
  // WebGL-only material that three's node renderer rejects outright ("NodeBuilder: Material
  // LineMaterial is not compatible"), which is why every frustum vanished on the WebGPU path. A plain
  // LineBasicMaterial renders on both backends and is visually identical at `lineWidth={1}` — the only
  // thing fat lines add is widths above 1, which this never used.
  const positions = useMemo(() => {
    const pairs: THREE.Vector3[][] = [
      [C, cs[0]], [C, cs[1]], [C, cs[2]], [C, cs[3]],
      [cs[0], cs[1]], [cs[1], cs[2]], [cs[2], cs[3]], [cs[3], cs[0]],
    ];
    const a = new Float32Array(pairs.length * 6);
    pairs.forEach(([p, q], i) => {
      a.set([p.x, p.y, p.z, q.x, q.y, q.z], i * 6);
    });
    return a;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center, corners]);

  return (
    <group>
      {/* `key` on the geometry: a BufferAttribute is not re-uploaded just because its array changed
          identity, so without it a re-solved calibration would keep drawing the old frustum. */}
      <lineSegments raycast={() => null}>
        <bufferGeometry key={positions.length + ':' + positions[0]}>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} toneMapped={false} />
      </lineSegments>
      <mesh position={C} raycast={() => null}>
        <sphereGeometry args={[0.04, 12, 12]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {picks?.map((p, i) => (
        <mesh key={`pk${i}`} position={p.world} raycast={() => null}>
          <sphereGeometry args={[0.03, 10, 10]} />
          <meshBasicMaterial color="#ffcc00" />
        </mesh>
      ))}
    </group>
  );
};
