import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { solveGridFrame, setGridFrame, cellDivFor } from './gridScale';

// THE FLOOR — drawn as LINES, not as a shader plane, and SCALED rather than rebuilt.
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
// ── WHAT THE GRID IS NOW: A RULER ──────────────────────────────────────────────────────────────────
// The geometry is built in NORMALISED units — one section is one unit — and the group is scaled to the
// section this zoom level calls for (gridScale.ts). So one small geometry per subdivision ratio serves
// every scale from a 20 cm prop to a 40 m arena, with no per-frame allocation and no rebuild.
//
// TWO THINGS ABOUT THAT SCALE ARE LOAD-BEARING:
//
// 1. IT IS `set(s, 1, s)`, NEVER `setScalar(s)`. Every vertex sits at y = 0.001 — a 1 mm lift off the
//    floor, because the beams draw their illumination boundary AT y = 0 and a coincident line pair
//    z-fights into a dashed mess as the camera moves. A uniform scale would shrink that lift along
//    with everything else: at section 0.01 it becomes 1e-5, which at close zoom is inside the depth
//    buffer's own quantum, and the z-fight the lift exists to prevent comes straight back — visible
//    only at small scales, which is the hardest place to catch it. The grid is FLAT, so scaling Y
//    means nothing to it anyway; leaving Y at 1 costs nothing and removes the whole failure.
//
// 2. IT FOLLOWS THE VIEW, snapped to a whole section. A grid pinned to the world origin is fine while
//    it is ±15 m across, but at section 0.05 that same grid is ±75 cm — so inspecting a prop three
//    metres from the origin would leave you with no floor and no numbers at all. Snapping the offset
//    to a multiple of the section is what keeps every line on a round world coordinate, which is what
//    lets the labels tell the truth. The ORIGIN is marked separately, by OriginGnomon.
//
// THIS COMPONENT IS ALSO THE SINGLE WRITER of the solved grid frame. It is mounted exactly when the
// grid is visible, and it publishes before the gnomon and the labels read (r3f runs equal-priority
// useFrame subscribers in mount order) — so all three agree about the section by construction rather
// than by three separate derivations that can drift.
const GRID_EXTENT = 15;        // sections from the centre, each way (the old grid's 30×30 at 1 m)
const FADE = 12;               // distance, in sections, at which a line has faded to nothing
const SECTION_COLOR = new THREE.Color('#d8d8d8');
const CELL_COLOR = new THREE.Color('#b0b0b0');
// The fade needs the line SUBDIVIDED — a single segment can only fade between its two ends, so a
// line through the centre would be brightest at the rim. One vertex per section is plenty.
const STEP = 1;

// How far the fine lines reach, per subdivision ratio — chosen so the number of fine lines on screen
// stays roughly constant across rungs. The original was a flat 0.25 m out to 6 m (24 cells each way)
// with the reason recorded: 0.25 m lines out to 15 m is 14k segments of visual noise. Holding the CELL
// COUNT constant rather than the distance is what makes the grid look the same at every scale, which
// is the whole point of a grid that re-steps.
const CELL_EXTENT: Record<number, number> = { 4: 6, 5: 5, 10: 3 };

function build(cellDiv: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const cellExtent = CELL_EXTENT[cellDiv] ?? 4;

  // Brightness at a point, from its distance to the centre. Squared falloff so the middle of the
  // grid stays readable while the edge dissolves rather than ending on a hard rectangle.
  const fade = (x: number, z: number): number => {
    const d = Math.hypot(x, z) / FADE;
    return d >= 1 ? 0 : (1 - d) * (1 - d);
  };

  const push = (x1: number, z1: number, x2: number, z2: number, base: THREE.Color) => {
    const a = fade(x1, z1), b = fade(x2, z2);
    if (a <= 0.001 && b <= 0.001) return;   // wholly outside the fade — never built, never drawn
    // Very slightly above the floor plane — see note 1 in the header. In normalised units this is
    // 0.001 SECTIONS, and because the group's Y scale stays 1 it is 1 mm on screen at every rung.
    pos.push(x1, 0.001, z1, x2, 0.001, z2);
    c.copy(base).multiplyScalar(a); col.push(c.r, c.g, c.b);
    c.copy(base).multiplyScalar(b); col.push(c.r, c.g, c.b);
  };

  // One family of lines, along both axes, subdivided by STEP so the fade has somewhere to happen.
  const family = (spacing: number, extent: number, base: THREE.Color, skipSections: boolean) => {
    for (let i = -extent; i <= extent + 1e-6; i += spacing) {
      // A cell line that lands exactly on a section line would double-draw it, brighter.
      if (skipSections && Math.abs(i - Math.round(i)) < 1e-6) continue;
      for (let t = -extent; t < extent - 1e-6; t += STEP) {
        const t2 = Math.min(t + STEP, extent);
        push(i, t, i, t2, base);   // along Z
        push(t, i, t2, i, base);   // along X
      }
    }
  };

  family(1 / cellDiv, cellExtent, CELL_COLOR, true);
  family(1, GRID_EXTENT, SECTION_COLOR, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// One geometry per subdivision ratio, built lazily and kept for the life of the app — the same
// lifetime the single geometry had before, for the same reason (nothing about them depends on the
// scene). There are at most three, they are a few hundred KB together, and they are SHARED, so they
// are deliberately not disposed when this unmounts: a remount would then get a disposed buffer.
const geometries = new Map<number, THREE.BufferGeometry>();
function geometryFor(cellDiv: number): THREE.BufferGeometry {
  let g = geometries.get(cellDiv);
  if (!g) { g = build(cellDiv); geometries.set(cellDiv, g); }
  return g;
}

export const GroundGrid: React.FC = () => {
  const ref = useRef<THREE.LineSegments>(null);
  // Last frame's section, for the hysteresis band that stops a slow dolly blinking the whole floor
  // between two decades. A ref, not state: this changes at pointer rate and must never re-render.
  const section = useRef(0);

  useFrame(({ camera, size }) => {
    const g = ref.current;
    if (!g) return;
    const f = solveGridFrame(camera, size.height, section.current);
    if (!f) { setGridFrame(null); return; }
    section.current = f.section;
    setGridFrame(f);

    // Swapping the geometry is a direct write, not React state: a rung change is rare (a few times
    // across a whole zoom) but routing it through a re-render would put React in the frame loop for
    // something that is one property assignment.
    const geo = geometryFor(f.cellDiv);
    if (g.geometry !== geo) g.geometry = geo;
    g.scale.set(f.section, 1, f.section);        // NEVER setScalar — see note 1 in the header
    g.position.set(f.originX, 0, f.originZ);     // follows the view, snapped to a whole section
  });

  // Stop the labels the moment the grid does. Without this the numbers freeze over a live viewport,
  // which reads as a renderer fault rather than as a hidden grid.
  useEffect(() => () => setGridFrame(null), []);

  return (
    // Never a pick target: it is a reference, and a full-floor pick plane would swallow every click
    // meant for the rig standing on it — the failure PlacementPlane's header describes.
    // `frustumCulled={false}` was already right and is now load-bearing: the group MOVES, so three's
    // cached bounding sphere would be tested against stale world bounds.
    <lineSegments ref={ref} geometry={geometryFor(cellDivFor(1))} raycast={() => null} frustumCulled={false}>
      <lineBasicMaterial vertexColors transparent opacity={0.85} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
};
