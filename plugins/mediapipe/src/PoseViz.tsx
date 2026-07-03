import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { Scene3D } from '../../../shared/protocol';
import * as poseStore from './poseStore';

// MediaPipe camera-pose visualization for the 3D Scene. Shows the webcam field as a floating vertical
// rectangle and plots one marker per detected person at their normalized (u,v) position on it. Fed
// from poseStore (bridged from the inference-running main window). Render-free: marker matrices update
// in useFrame so high-rate pose updates never trigger React re-renders.
//
// This is a spatial DEBUG overlay of the raw camera field, not a venue-mapped placement (camera→venue
// homography is out of scope for v1 — see docs/MEDIAPIPE.md). Gated by the scene's mediapipeViz flag.

const CAM_W = 4;      // camera field width,  metres (16:9)
const CAM_H = 2.25;   // camera field height, metres
const BASE_Y = 0.5;   // lift the field off the floor
const Z = -0.5;       // set it just behind the origin so it doesn't overlap the venue zones
const R = 0.09;       // marker radius, metres
const MAX = 6;        // matches the engine's max numPoses

const FIELD_COLOR = '#38bdf8';
const MARK_COLOR = '#f472b6';

const rect = (pts: [number, number, number][]): [number, number, number][] => [...pts, pts[0]];

const PoseViz: React.FC<{ scene3D: Scene3D }> = ({ scene3D }) => {
  void scene3D; // enable gating is handled by the host (SceneVizContribution.enabled)
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dets = poseStore.getDetections();
    const n = Math.min(dets.length, MAX);
    const pulse = 1 + 0.1 * Math.sin(state.clock.elapsedTime * 4);
    for (let i = 0; i < n; i++) {
      const d = dets[i];
      dummy.position.set(d.u * CAM_W - CAM_W / 2, BASE_Y + d.v * CAM_H, Z + 0.02);
      dummy.scale.setScalar(pulse);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  });

  const fieldRect = rect([
    [-CAM_W / 2, BASE_Y, Z], [CAM_W / 2, BASE_Y, Z],
    [CAM_W / 2, BASE_Y + CAM_H, Z], [-CAM_W / 2, BASE_Y + CAM_H, Z],
  ]);

  return (
    <group>
      <Line points={fieldRect} color={FIELD_COLOR} lineWidth={1.4} />
      <mesh position={[0, BASE_Y + CAM_H / 2, Z]} raycast={() => null}>
        <planeGeometry args={[CAM_W, CAM_H]} />
        <meshBasicMaterial color={FIELD_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <instancedMesh ref={meshRef} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[R, 16, 16]} />
        <meshBasicMaterial color={MARK_COLOR} toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

export default PoseViz;
