import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { Scene3D } from '../../../shared/protocol';
import * as augmentaStore from './augmentaStore';

// Augmenta tracking visualization for the 3D Scene, gated by the scene's augmentaViz flag. Unlike the
// MediaPipe camera-pose viz (which needs a 4-point homography to recover real-world position from an
// uncalibrated webcam), the Augmenta box outputs positions already in a real-world, calibrated field —
// normalized [0..1] over a field whose real size (metres) it reports in the scene message. So we draw
// the field rectangle directly at metric scale and place a marker per object at its real position:
//   x = (u − 0.5)·W   (centred left↔right)      z = v·D   (near edge v=0 → far edge v=1)
// Fed from augmentaStore; render-free (marker matrices update in useFrame, never React state).

const R = 0.09;                 // marker radius, metres
const MAX = 64;                 // instanced marker cap
const FIELD_COLOR = '#38bdf8';
const MARK_COLOR = '#f472b6';
const DEFAULT_W = 4, DEFAULT_D = 3; // fallback field size until the first /au/scene arrives

const rect = (pts: [number, number, number][]): [number, number, number][] => [...pts, pts[0]];

// The field size + object positions come from augmentaStore (the Augmenta box reports real metres), so
// this viz doesn't read scene3D — but it keeps the SceneVizContribution's { scene3D } prop shape.
const AugmentaViz: React.FC<{ scene3D: Scene3D }> = () => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const objs = augmentaStore.getObjects();
    const sc = augmentaStore.getScene();
    const W = sc.sceneW > 0 ? sc.sceneW : DEFAULT_W;
    const D = sc.sceneH > 0 ? sc.sceneH : DEFAULT_D;
    const pulse = 1 + 0.1 * Math.sin(state.clock.elapsedTime * 4);
    let n = 0;
    for (let i = 0; i < objs.length && n < MAX; i++) {
      const o = objs[i];
      dummy.position.set((o.u - 0.5) * W, R, o.v * D);
      dummy.scale.setScalar(pulse);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  });

  // The field rectangle (recomputed only when the reported field size changes). The near edge (z=0)
  // sits at the scene origin's x-axis; the far edge is at z=D.
  const sc = augmentaStore.getScene();
  const W = sc.sceneW > 0 ? sc.sceneW : DEFAULT_W;
  const D = sc.sceneH > 0 ? sc.sceneH : DEFAULT_D;
  const geom = useMemo(() => {
    const w = W / 2;
    return {
      line: rect([[-w, 0, 0], [w, 0, 0], [w, 0, D], [-w, 0, D]]),
      plane: { args: [W, D] as [number, number], pos: [0, 0.001, D / 2] as [number, number, number] },
    };
  }, [W, D]);

  return (
    <group>
      <Line points={geom.line} color={FIELD_COLOR} lineWidth={1.4} />
      <mesh position={geom.plane.pos} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={geom.plane.args} />
        <meshBasicMaterial color={FIELD_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <instancedMesh ref={meshRef} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[R, 16, 16]} />
        <meshBasicMaterial color={MARK_COLOR} toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

export default AugmentaViz;
