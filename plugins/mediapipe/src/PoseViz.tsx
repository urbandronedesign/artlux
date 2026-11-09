import React, { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
// NOT drei's <Line>: its LineMaterial is WebGL-only, and on the WebGPU path (the 3D view's default) a
// calibration change that reshaped it threw "drawIndexed: Value is infinite" on every frame and froze
// the whole 3D view (2026-11-09). PolyLine is the host's one line impl for both backends.
import { PolyLine } from '@/components/Simulator3D/PolyLine';
import { Scene3D } from '../../../shared/protocol';
import * as poseStore from './poseStore';
import { applyH, imageToWorld, type Mat3 } from './poseHomography';
import { footPoint, worldQuad, imageCornerPin } from './poseFloor';
import { CAM_W, CAM_H, BASE_Y, Z_BB, imageToField, areaToField } from './poseField';
import { points as areaPoints } from './poseArea';

// MediaPipe camera-pose visualization for the 3D Scene, gated by the scene's mediapipeViz flag:
//   • CALIBRATED FLOOR (scene3D.mediapipeFloor set) — draws the real floor rectangle (metres) and places a
//     marker per person at their homography-mapped ground position (foot → floor). This is the
//     real-world position preview. Mirrors the LiDAR TrackingViz floor placement.
//   • THE CAMERA FIELD — a vertical panel standing for the camera picture (poseField.ts). Drawn when the
//     floor is not calibrated (then the person markers sit on it, raw image u,v), AND whenever an
//     interaction area is marked: the area's outline and every body part the zones count are drawn on
//     it, and the LiDAR plugin draws the trigger zones on the same panel through the camera area's
//     toWorld(). So "my hand is in the pad" can be checked in the 3D view, not only in the calibration.
// Fed from poseStore; render-free (marker matrices update in useFrame, never React state).

const R = 0.09;       // marker radius, metres
const MAX = 6;        // matches the engine's max numPoses
const PART_R = 0.045; // a body part on the panel — small: it is one hand among a pad's worth of space
const MAX_PARTS = MAX * 6;
const FLOOR_COLOR = '#38bdf8';
const AREA_COLOR = '#e5e7eb';
const MARK_COLOR = '#f472b6';
const PART_COLOR = '#fde047';

const rect = (pts: [number, number, number][]): [number, number, number][] => [...pts, pts[0]];

const PoseViz: React.FC<{ scene3D: Scene3D }> = ({ scene3D }) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const partsRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const floor = scene3D.mediapipeFloor;
  const area = scene3D.mediapipeArea;
  // The image→floor homography, recomputed only when the calibration changes.
  const H = useMemo<Mat3 | null>(
    () => (floor ? imageToWorld(imageCornerPin(floor.imageQuad), worldQuad(floor)) : null),
    [floor],
  );
  // Keep the latest mapping in a ref so useFrame reads it without re-subscribing.
  const mapRef = useRef<{ H: Mat3 | null; area: typeof area }>({ H: null, area: undefined });
  mapRef.current = { H, area };

  useFrame((state) => {
    const mesh = meshRef.current;
    if (mesh) {
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
          // Uncalibrated: raw image (u,v) on the camera-field panel.
          dummy.position.set(...imageToField(d.u, d.v, 0.02));
        }
        dummy.scale.setScalar(pulse);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        n++;
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }

    // The parts the zones count — the SAME points (poseArea.points, area space) mapped back onto the
    // panel through the same area homography the zones are drawn with.
    const parts = partsRef.current;
    if (parts) {
      const a = mapRef.current.area;
      let n = 0;
      if (a) {
        for (const p of areaPoints()) {
          if (n >= MAX_PARTS) break;
          const w = areaToField(a, p.u, p.v, 0.03);
          if (!w) continue;
          dummy.position.set(...w);
          dummy.scale.setScalar(1);
          dummy.updateMatrix();
          parts.setMatrixAt(n++, dummy.matrix);
        }
      }
      parts.count = n;
      parts.instanceMatrix.needsUpdate = true;
    }
  });

  const showField = !floor || !!area;
  const fieldLine = rect([
    [-CAM_W / 2, BASE_Y, Z_BB], [CAM_W / 2, BASE_Y, Z_BB],
    [CAM_W / 2, BASE_Y + CAM_H, Z_BB], [-CAM_W / 2, BASE_Y + CAM_H, Z_BB],
  ]);
  // The marked area on the panel: its four corners through the area homography (a quad, as the camera
  // sees it — not a rectangle). Null when the stored quad is degenerate.
  const areaLine = useMemo(() => {
    if (!area) return null;
    const c = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => areaToField(area, u, v, 0.01));
    return c.every(Boolean) ? rect(c as [number, number, number][]) : null;
  }, [area]);
  const floorLine = floor
    ? rect([[-floor.width / 2, 0, 0], [floor.width / 2, 0, 0], [floor.width / 2, 0, floor.depth], [-floor.width / 2, 0, floor.depth]])
    : null;

  return (
    <group>
      {floor && floorLine && (
        <>
          <PolyLine points={floorLine} color={FLOOR_COLOR} />
          {/* 1×1 geometry sized by `scale`, never by planeGeometry args — a changed args array swaps the
              geometry of a mesh that has already drawn, which freezes the WebGPU 3D view for good (the floor
              calibration resizes it after mount). See TrackingViz. */}
          <mesh position={[0, 0.001, floor.depth / 2]} rotation={[-Math.PI / 2, 0, 0]} scale={[floor.width, floor.depth, 1]} raycast={() => null}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial color={FLOOR_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        </>
      )}
      {showField && (
        <>
          <PolyLine points={fieldLine} color={FLOOR_COLOR} />
          <mesh position={[0, BASE_Y + CAM_H / 2, Z_BB]} scale={[CAM_W, CAM_H, 1]} raycast={() => null}>
            <planeGeometry args={[1, 1]} />
            <meshBasicMaterial color={FLOOR_COLOR} transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          {areaLine && <PolyLine points={areaLine} color={AREA_COLOR} dashed dashSize={0.08} gapSize={0.06} opacity={0.8} />}
        </>
      )}
      <instancedMesh ref={meshRef} args={[undefined, undefined, MAX]} frustumCulled={false} raycast={() => null}>
        <sphereGeometry args={[R, 16, 16]} />
        <meshBasicMaterial color={MARK_COLOR} toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={partsRef} args={[undefined, undefined, MAX_PARTS]} frustumCulled={false} raycast={() => null}>
        <sphereGeometry args={[PART_R, 12, 12]} />
        <meshBasicMaterial color={PART_COLOR} toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

export default PoseViz;
