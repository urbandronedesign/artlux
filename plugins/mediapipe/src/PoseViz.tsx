import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import { Scene3D } from '../../../shared/protocol';
import * as poseStore from './poseStore';
import { applyH, imageToWorld, type Mat3 } from './poseHomography';
import { footPoint, worldQuad, imageCornerPin } from './poseFloor';

// MediaPipe camera-pose visualization for the 3D Scene. Two modes, gated by the scene's mediapipeViz flag:
//   • CALIBRATED (scene3D.mediapipeFloor set) — draws the real floor rectangle (metres) and places a
//     marker per person at their homography-mapped ground position (foot → floor). This is the
//     real-world position preview. Mirrors the LiDAR TrackingViz floor placement.
//   • UNCALIBRATED — falls back to a floating vertical "camera field" billboard with raw image (u,v)
//     markers (a spatial debug overlay), prompting the user to run Pose Floor Calibration.
// Fed from poseStore; render-free (marker matrices update in useFrame, never React state).

const R = 0.09;       // marker radius, metres
const MAX = 6;        // matches the engine's max numPoses
const FLOOR_COLOR = '#38bdf8';
const MARK_COLOR = '#f472b6';

// Uncalibrated billboard constants.
const CAM_W = 4, CAM_H = 2.25, BASE_Y = 0.5, Z_BB = -0.5;

const rect = (pts: [number, number, number][]): [number, number, number][] => [...pts, pts[0]];

const PoseViz: React.FC<{ scene3D: Scene3D }> = ({ scene3D }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const floor = scene3D.mediapipeFloor;
  // The image→floor homography, recomputed only when the calibration changes.
  const H = useMemo<Mat3 | null>(
    () => (floor ? imageToWorld(imageCornerPin(floor.imageQuad), worldQuad(floor)) : null),
    [floor],
  );
  // Keep the latest mapping in a ref so useFrame reads it without re-subscribing.
  const mapRef = useRef<{ H: Mat3 | null; w: number; d: number }>({ H: null, w: 0, d: 0 });
  mapRef.current = { H, w: floor?.width ?? 0, d: floor?.depth ?? 0 };

  useFrame((state) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const dets = poseStore.getDetections();
    const { H: h } = mapRef.current;
    const pulse = 1 + 0.1 * Math.sin(state.clock.elapsedTime * 4);
    let n = 0;
    for (let i = 0; i < dets.length && n < MAX; i++) {
      const d = dets[i];
      if (h) {
        // Calibrated: map the ground-contact point to real floor metres.
        const foot = footPoint(d.landmarks);
        if (!foot) continue;
        const [x, z] = applyH(h, foot[0], foot[1]);
        dummy.position.set(x, R, z);
      } else {
        // Uncalibrated: raw image (u,v) on the vertical camera-field billboard.
        dummy.position.set(d.u * CAM_W - CAM_W / 2, BASE_Y + d.v * CAM_H, Z_BB + 0.02);
      }
      dummy.scale.setScalar(pulse);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
      n++;
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  });

  // Geometry: the calibrated floor rectangle, or the uncalibrated camera-field billboard.
  const geom = useMemo(() => {
    if (floor) {
      const w = floor.width / 2, d = floor.depth;
      return {
        line: rect([[-w, 0, 0], [w, 0, 0], [w, 0, d], [-w, 0, d]]),
        plane: { args: [floor.width, floor.depth] as [number, number], pos: [0, 0.001, d / 2] as [number, number, number], rot: [-Math.PI / 2, 0, 0] as [number, number, number] },
      };
    }
    return {
      line: rect([[-CAM_W / 2, BASE_Y, Z_BB], [CAM_W / 2, BASE_Y, Z_BB], [CAM_W / 2, BASE_Y + CAM_H, Z_BB], [-CAM_W / 2, BASE_Y + CAM_H, Z_BB]]),
      plane: { args: [CAM_W, CAM_H] as [number, number], pos: [0, BASE_Y + CAM_H / 2, Z_BB] as [number, number, number], rot: [0, 0, 0] as [number, number, number] },
    };
  }, [floor]);

  return (
    <group>
      <Line points={geom.line} color={FLOOR_COLOR} lineWidth={1.4} />
      <mesh position={geom.plane.pos} rotation={geom.plane.rot} raycast={() => null}>
        <planeGeometry args={geom.plane.args} />
        <meshBasicMaterial color={FLOOR_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <instancedMesh ref={meshRef} args={[undefined, undefined, MAX]} frustumCulled={false}>
        <sphereGeometry args={[R, 16, 16]} />
        <meshBasicMaterial color={MARK_COLOR} toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

export default PoseViz;
