import React from 'react';

// THREE COLOURED ARMS — the primitives, drawn with things BOTH backends have.
//
// This started as a renderer-agnostic stand-in for drei's <GizmoViewport>, for the WebGPU path.
// GizmoViewport draws its axis heads as sprites and builds them through
// `gl.capabilities.getMaxAnisotropy()` — a WebGLRenderer-only API. On the node renderer that throws
// during render, and because it throws INSIDE the Canvas it takes the entire viewport down rather
// than just the widget: the whole 3D scene went black on the first frame.
//
// So: cylinders and meshBasicMaterial, no textures, no sprites. No labels either — the colours are
// the convention this app already uses everywhere else (X red, Y green, Z blue), and a label would
// need a texture, which is what caused the problem.
//
// TWO CALLERS, TWO SETS OF PROPORTIONS. <AxisTriad> is the corner widget inside <GizmoHelper>, which
// supplies its own viewport and camera. <OriginGnomon> puts the same arms in the WORLD, at (0,0,0),
// and needs a much slimmer profile: the widget's 4.4%-of-length rod with a 16% ball on the end reads
// as a fat lollipop when it is sitting in the scene at the exact point recentred GLB pivots land and
// placement clicks are aimed. Hence the geometry is parameterised and neither caller hardcodes it.
//
// Nothing here is pickable. `raycast` is stubbed rather than left to hit-test a widget that is not
// meant to be clicked — and in the world gnomon's case, because the origin is the single most
// aimed-at point in the scene and a pick target there would eat clicks.
const AXES: Array<{ dir: [number, number, number]; color: string }> = [
  { dir: [1, 0, 0], color: '#ff3653' },  // X
  { dir: [0, 1, 0], color: '#28c76f' },  // Y
  { dir: [0, 0, 1], color: '#2f7cf6' },  // Z
];

const NONE = () => null;

interface ArmsProps {
  /** Arm length, in the units of whatever group this sits in. */
  len: number;
  /** Rod radius, same units. */
  radius: number;
  /** Sphere cap radius on the positive end; 0 or omitted draws no cap. */
  head?: number;
  /** Radial segments. The corner widget can afford more than a scene overlay repeated per frame. */
  segments?: number;
  /**
   * Draw through whatever is in front of it, like a gizmo. OFF for the corner widget, which has its
   * own viewport and nothing to be hidden by.
   *
   * ON for the world gnomon, and that reversed a decision. Depth-testing it is the honest choice in
   * the abstract — it is a mark on a point in space, and drawing it through a wall misreports where
   * that point is. Then running it showed what "in the abstract" was missing: in THIS app the world
   * origin is normally ON the venue floor, and a venue floor is normally a plane modelled at y = 0.
   * So the gnomon spent its life buried a millimetre under the one object guaranteed to cover it, in
   * exactly the situation you reach for it. A reference you cannot see is not a reference.
   */
  overlay?: boolean;
}

export const AxisArms: React.FC<ArmsProps> = ({ len, radius, head = 0, segments = 8, overlay = false }) => (
  <group>
    {AXES.map(({ dir, color }, i) => {
      const [x, y, z] = dir;
      // Cylinders are built along +Y, so rotate each arm onto its axis rather than computing a
      // quaternion per frame — these three orientations are fixed and known.
      const rot: [number, number, number] = x ? [0, 0, -Math.PI / 2] : z ? [Math.PI / 2, 0, 0] : [0, 0, 0];
      const mid: [number, number, number] = [x * len / 2, y * len / 2, z * len / 2];
      const tip: [number, number, number] = [x * len, y * len, z * len];
      // Slightly translucent when it draws on top, so it reads as an overlay rather than as a solid
      // object that happens to be in front of the venue — the same cue TransformControls uses.
      const mat = (
        <meshBasicMaterial
          color={color}
          toneMapped={false}
          depthTest={!overlay}
          transparent={overlay}
          opacity={overlay ? 0.9 : 1}
        />
      );
      return (
        <group key={i}>
          <mesh position={mid} rotation={rot} raycast={NONE} renderOrder={overlay ? 998 : 0}>
            <cylinderGeometry args={[radius, radius, len, segments]} />
            {mat}
          </mesh>
          {head > 0 && (
            <mesh position={tip} raycast={NONE} renderOrder={overlay ? 998 : 0}>
              <sphereGeometry args={[head, 12, 10]} />
              {mat}
            </mesh>
          )}
        </group>
      );
    })}
  </group>
);

/** The corner orientation widget, inside <GizmoHelper>. Proportions unchanged from when it shipped. */
export const AxisTriad: React.FC = () => <AxisArms len={0.8} radius={0.035} head={0.13} />;
