import React, { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { worldPerPixel } from './screenScale';

// One numbered calibration anchor (a board pose pick or an Auto-Align correspondence) drawn in the
// 3D scene.
//
// THE MARKER IS SCREEN-CONSTANT, NOT WORLD-SIZED — and that is the whole point of this file.
// It used to be a sphere of a fixed 0.04 world units. That is a tidy 4 cm dot on a 12 m venue and a
// BLOT THE SIZE OF THE MODEL on a 30 cm one, because the operator zooms in to work on a small mesh
// and the marker grows on screen at exactly the same rate. And the marker is a raycast target that
// stops propagation, so once it covers the model, every later click aimed at the SURFACE landed on an
// already-placed marker instead: the click either did nothing visible or (before the edit mode was
// armed) moved that anchor to where you clicked. The smaller the mesh, the worse it got, until the
// first anchor made the rest of the mesh effectively unpickable.
//
// The camera-image markers next to it have always been screen-constant (r = 8 css px at any zoom —
// see the calibration plugin's CameraViewport). This is the 3D half of the same rule, so the two
// sides of a correspondence now read the same at every scale.

const MARKER_PX = 7;      // on-screen radius of a marker, in css px
const MARKER_PX_SEL = 9.5; // the selected one reads larger, same ratio as before (×1.35)

const _p = new THREE.Vector3();

interface Props {
  world: [number, number, number];
  index: number;              // 0-based; the label shows index + 1
  selected: boolean;
  /** Wired only in the markerless flow — the board flow's markers are display-only (no raycast). */
  onSelect?: (i: number) => void;
  /** Press-and-drag the marker to MOVE its pick across the venue (manual/board pose picks). Grabbing
   *  the marker is the consent — this is the direct-manipulation edit, no armed mode needed. */
  onDragStart?: (i: number) => void;
}

export const AnchorMarker: React.FC<Props> = ({ world, index, selected, onSelect, onDragStart }) => {
  const ref = useRef<THREE.Group>(null);
  const col = selected ? '#ffffff' : '#00e5ff';

  // Rescale per frame so the sphere subtends a fixed number of css pixels. The geometry is a UNIT
  // sphere and the group scale carries the size, so the raycast target tracks the drawn size exactly
  // — a marker you cannot see is not one you can accidentally click either.
  useFrame(({ camera, size }) => {
    const g = ref.current;
    if (!g) return;
    const cam = camera as THREE.PerspectiveCamera;
    if (!cam.isPerspectiveCamera || !size.height) return;
    const d = cam.position.distanceTo(g.getWorldPosition(_p));
    g.scale.setScalar(Math.max(1e-6, (selected ? MARKER_PX_SEL : MARKER_PX) * worldPerPixel(cam, size.height, d)));
  });

  return (
    // Starts effectively invisible, not at unit scale: the first useFrame is a frame away, and a unit
    // sphere for that frame is a cyan blot across the viewport every time a marker is placed.
    <group ref={ref} position={world} scale={0.0001}>
      {/* Depth test off so a pick on a far wall isn't hidden by the model in front of it. */}
      <mesh renderOrder={999} raycast={onSelect || onDragStart ? undefined : () => null}
        onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(index); } : undefined}
        onPointerDown={onDragStart ? (e) => { e.stopPropagation(); onDragStart(index); } : undefined}>
        <sphereGeometry args={[1, 16, 16]} />
        <meshBasicMaterial color={col} depthTest={false} transparent opacity={0.95} />
      </mesh>
      <Html center style={{ pointerEvents: 'none' }}>
        <div style={{ transform: 'translateY(-15px)', font: 'bold 11px sans-serif', color: col, textShadow: '0 0 3px #000,0 0 3px #000', whiteSpace: 'nowrap' }}>{index + 1}</div>
      </Html>
    </group>
  );
};
