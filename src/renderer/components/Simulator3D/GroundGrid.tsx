import React, { useEffect, useMemo } from 'react';
import * as THREE from 'three';

// THE FLOOR — drawn as LINES, not as a shader plane.
//
// It used to be drei's <Grid>, which is a 30×30 PlaneGeometry carrying a raw ShaderMaterial: the mesh
// is deliberately UNROTATED and the shader is what projects it onto the ground and makes it infinite.
// three's node renderer rejects a raw ShaderMaterial outright, so on the WebGPU backend — the one the
// 3D scene DEFAULTS to — the shader never ran and what was left was the bare geometry: a black wall
// standing at the origin, thirty metres across, occluding the rig behind it. An operator reported it
// as "there is a black rectangle in my scene", which is exactly what it was.
//
// It is the third thing in this scene to be lost that way (the projector frustum's fat LineMaterial,
// the beams' instanceColor tint, and now this), so the fix is the one that keeps working:
// LineSegments + LineBasicMaterial, which both backends render identically.
//
// WHAT CHANGED, HONESTLY: the grid is now FINITE. drei's was `infiniteGrid`, extending forever and
// faded out by distance. This one is built once, out to GRID_EXTENT, with the same fade baked into
// its vertex colours — so it looks the same inside the fade radius and simply stops beyond it, which
// is where the old one had already faded to nothing.
const GRID_EXTENT = 15;        // metres from the origin, each way (the old grid's 30×30)
const SECTION = 1;             // metre lines — the ones you count
const CELL = 0.25;             // fine lines, near the origin only
const CELL_EXTENT = 6;         // …because 0.25 m lines out to 15 m is 14k segments of visual noise
const FADE = 12;               // distance at which a line has faded to nothing
const SECTION_COLOR = new THREE.Color('#d8d8d8');
const CELL_COLOR = new THREE.Color('#b0b0b0');
// The fade needs the line SUBDIVIDED — a single segment can only fade between its two ends, so a
// line through the origin would be brightest at the rim. One vertex per metre is plenty.
const STEP = 1;

function build(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();

  // Brightness at a point, from its distance to the origin. Squared falloff so the middle of the
  // grid stays readable while the edge dissolves rather than ending on a hard rectangle.
  const fade = (x: number, z: number): number => {
    const d = Math.hypot(x, z) / FADE;
    return d >= 1 ? 0 : (1 - d) * (1 - d);
  };

  const push = (x1: number, z1: number, x2: number, z2: number, base: THREE.Color) => {
    const a = fade(x1, z1), b = fade(x2, z2);
    if (a <= 0.001 && b <= 0.001) return;   // wholly outside the fade — never built, never drawn
    // Very slightly above the floor plane: the beams' illumination boundary is drawn AT y=0, and a
    // coincident line pair z-fights into a dashed mess as the camera moves.
    pos.push(x1, 0.001, z1, x2, 0.001, z2);
    c.copy(base).multiplyScalar(a); col.push(c.r, c.g, c.b);
    c.copy(base).multiplyScalar(b); col.push(c.r, c.g, c.b);
  };

  // One family of lines, along both axes, subdivided by STEP so the fade has somewhere to happen.
  const family = (spacing: number, extent: number, base: THREE.Color, skipSections: boolean) => {
    for (let i = -extent; i <= extent + 1e-6; i += spacing) {
      // A cell line that lands exactly on a section line would double-draw it, brighter.
      if (skipSections && Math.abs(i / SECTION - Math.round(i / SECTION)) < 1e-6) continue;
      for (let t = -extent; t < extent - 1e-6; t += STEP) {
        const t2 = Math.min(t + STEP, extent);
        push(i, t, i, t2, base);   // along Z
        push(t, i, t2, i, base);   // along X
      }
    }
  };

  family(CELL, CELL_EXTENT, CELL_COLOR, true);
  family(SECTION, GRID_EXTENT, SECTION_COLOR, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

export const GroundGrid: React.FC = () => {
  // Built once for the life of the app — nothing about it depends on the scene.
  const geometry = useMemo(build, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    // Never a pick target: it is a reference, and a full-floor pick plane would swallow every click
    // meant for the rig standing on it — the failure PlacementPlane's header describes.
    <lineSegments geometry={geometry} raycast={() => null} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.85} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
};
