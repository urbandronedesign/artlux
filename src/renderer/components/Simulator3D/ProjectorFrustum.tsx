import React, { useMemo } from 'react';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { ProjectorCalibration } from '../../../../shared/protocol';
import { frustumCorners } from '@artlux/plugin-calibration/renderer';

// Draws the recovered virtual projector's frustum in the 3D scene: optical center + the four
// image-corner rays + the far rectangle. A correctly-solved pose puts the apex at the real projector's
// position and the frustum spanning the projection — the visual accuracy gate for Phase 3. Optional
// markers show the operator's pose-pick world points.
export const ProjectorFrustum: React.FC<{
  calibration: ProjectorCalibration;
  depth?: number;
  color?: string;
  picks?: Array<{ world: [number, number, number] }>;
}> = ({ calibration, depth = 3, color = '#00ffaa', picks }) => {
  const { center, corners } = useMemo(
    () => frustumCorners(calibration.intrinsics, calibration.rotation, calibration.translation as [number, number, number], calibration.imageSize, depth),
    [calibration, depth],
  );
  const C = new THREE.Vector3(...center);
  const cs = corners.map(c => new THREE.Vector3(...c));
  const edges: [THREE.Vector3, THREE.Vector3][] = [
    [C, cs[0]], [C, cs[1]], [C, cs[2]], [C, cs[3]],
    [cs[0], cs[1]], [cs[1], cs[2]], [cs[2], cs[3]], [cs[3], cs[0]],
  ];
  return (
    <group>
      {edges.map((e, i) => <Line key={i} points={[e[0], e[1]]} color={color} lineWidth={1} />)}
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
