import React from 'react';
import { MeshReflectorMaterial } from '@react-three/drei';

// Real-time planar reflections: a large mirror plane at the world floor (y=0) that
// reflects the LEDs and venue meshes — the cheap "equivalent" to ray-traced floor
// reflections. Subtle blur + low mix so it reads as a polished floor, not a mirror.
export const ReflectiveFloor: React.FC = () => (
  // Sit just below y=0 so it doesn't z-fight the grid (which is coplanar at y=0).
  // depthScale=0 disables depth-distance blur (flat floor) — avoids per-frame flicker.
  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
    <planeGeometry args={[60, 60]} />
    <MeshReflectorMaterial
      resolution={512}
      mixBlur={1}
      mixStrength={1.2}
      blur={[200, 60]}
      mirror={0.5}
      depthScale={0}
      color="#0a0a0a"
      metalness={0.5}
      roughness={0.85}
    />
  </mesh>
);
