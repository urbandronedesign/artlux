import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { getSnapHover } from './vertexSnap';
import { worldPerPixel } from './screenScale';

// The vertex the next click will snap to, shown before you commit it.
//
// TWO STATES, because a preview that only appears once you have already hit the target cannot help you
// aim: FAINT and small while the vertex is merely the nearest candidate (steer toward it), SOLID and
// larger once it will actually capture the click. The transition is the feedback — you can see the
// moment the click stops being a surface point and becomes a corner.
//
// Mounted only while a calibration pick mode is armed. It reads the hover channel every frame rather
// than taking a prop, because that channel updates at pointer rate and a prop would re-render the
// whole 3D tree on every mouse move. Both states are written straight onto the material, for the same
// reason. Screen-constant like the anchor markers — see screenScale.ts.
//
// Amber, and never cyan: cyan is a PLACED anchor. This is where a point would go, not where one is.

const ARMED_PX = 11;
const PREVIEW_PX_SIZE = 7;

export const SnapCursor: React.FC = () => {
  const ref = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ camera, size }) => {
    const g = ref.current;
    if (!g) return;
    const h = getSnapHover();
    const cam = camera as THREE.PerspectiveCamera;
    if (!h || !cam.isPerspectiveCamera || !size.height) { g.visible = false; return; }
    g.visible = true;
    g.position.copy(h.point);
    const d = cam.position.distanceTo(g.position);
    const px = h.armed ? ARMED_PX : PREVIEW_PX_SIZE;
    g.scale.setScalar(Math.max(1e-6, px * worldPerPixel(cam, size.height, d)));
    const m = matRef.current;
    if (m) { m.opacity = h.armed ? 1 : 0.45; m.wireframe = !h.armed; }
  });

  return (
    <group ref={ref} visible={false} scale={0.0001}>
      {/* Never a pick target itself — it sits exactly where you are aiming, so raycasting it would
          make it swallow the very click it is advertising. */}
      <mesh renderOrder={1000} raycast={() => null}>
        <sphereGeometry args={[1, 12, 10]} />
        <meshBasicMaterial ref={matRef} color="#ffd400" depthTest={false} transparent opacity={0.45} wireframe />
      </mesh>
    </group>
  );
};
