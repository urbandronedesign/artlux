import React from 'react';
import { useGLTF } from '@react-three/drei';
import { Scene3D } from '../../../../shared/protocol';

const DEG = Math.PI / 180;

// Loads a GLB/glTF venue model (from a Blob object URL) and places it at real-world
// meter scale. 1 GLB unit = 1 m by default; `modelScale` corrects if needed.
export const VenueModel: React.FC<{ url: string; scene3D: Scene3D }> = ({ url, scene3D }) => {
  const { scene } = useGLTF(url);
  const s = scene3D;
  return (
    <primitive
      object={scene}
      scale={s.modelScale}
      position={[s.modelPosition.x, s.modelPosition.y, s.modelPosition.z]}
      rotation={[s.modelRotation.x * DEG, s.modelRotation.y * DEG, s.modelRotation.z * DEG]}
    />
  );
};
