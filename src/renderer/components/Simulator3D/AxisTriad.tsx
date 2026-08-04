import React from 'react';

// A renderer-agnostic stand-in for drei's <GizmoViewport>, for the WebGPU path.
//
// GizmoViewport draws its axis heads as sprites and builds them through
// `gl.capabilities.getMaxAnisotropy()` — a WebGLRenderer-only API. On the node renderer that throws
// during render, and because it throws INSIDE the Canvas it takes the entire viewport down rather
// than just the widget: the whole 3D scene went black on the first frame.
//
// This draws the same information with primitives both backends have: three coloured arms with a cap
// on the positive end. No labels — the colours are the convention this app already uses everywhere
// else (X red, Y green, Z blue), and a label would need a texture, which is what caused the problem.
//
// It lives inside <GizmoHelper>, which supplies the corner viewport and the orientation; only the
// contents differ. Nothing here is pickable, so `raycast` is stubbed rather than left to hit-test a
// widget that is not meant to be clicked.
const AXES: Array<{ dir: [number, number, number]; color: string }> = [
  { dir: [1, 0, 0], color: '#ff3653' },  // X
  { dir: [0, 1, 0], color: '#28c76f' },  // Y
  { dir: [0, 0, 1], color: '#2f7cf6' },  // Z
];

const LEN = 0.8;
const NONE = () => null;

export const AxisTriad: React.FC = () => (
  <group>
    {AXES.map(({ dir, color }, i) => {
      const [x, y, z] = dir;
      // Cylinders are built along +Y, so rotate each arm onto its axis rather than computing a
      // quaternion per frame — these three orientations are fixed and known.
      const rot: [number, number, number] = x ? [0, 0, -Math.PI / 2] : z ? [Math.PI / 2, 0, 0] : [0, 0, 0];
      const mid: [number, number, number] = [x * LEN / 2, y * LEN / 2, z * LEN / 2];
      const tip: [number, number, number] = [x * LEN, y * LEN, z * LEN];
      return (
        <group key={i}>
          <mesh position={mid} rotation={rot} raycast={NONE}>
            <cylinderGeometry args={[0.035, 0.035, LEN, 8]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
          <mesh position={tip} raycast={NONE}>
            <sphereGeometry args={[0.13, 12, 10]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        </group>
      );
    })}
  </group>
);
