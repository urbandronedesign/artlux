import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { solveGridFrame, setGridFrame, gridFamilies } from './gridScale';
import { gridCamera } from './gridSpace';

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
// ── 2026-11-23: CONTINUOUS, NOT STEPPED (owner: "blinking when I rotate", "should be smooth, no popping",
// "light grey not white") ─────────────────────────────────────────────────────────────────────────────
// The grid was ONE lattice re-stepped along a 1-2-5 ladder: each step swapped every line at once (a pop),
// orbiting moved the reference point across the step's band (a blink), and its fade ring jumped a whole
// section each time the lattice re-snapped. It is now THREE DECADE FAMILIES (gridScale.gridFamilies):
// each is the same unit lattice scaled to its own spacing, snapped to its OWN spacing (so the finest
// one follows the view in fine steps), with an opacity from its own on-screen spacing. Zooming only
// changes opacities. The coarser families' lines lie on the finer ones' and draw over them — that is
// what makes them the major lines; nothing else marks them.
const EXTENT = 24;             // spacings from the centre, each way, per family
const FADE = 20;               // distance, in that family's spacings, at which a line has faded out
const LINE_COLOR = new THREE.Color('#a4a4a4');   // light grey — a reference, not a feature
const LINE_OPACITY = 0.55;     // a family at full strength; overlapping majors build up from there
// The fade needs the line SUBDIVIDED — a single segment can only fade between its two ends, so a
// line through the centre would be brightest at the rim. Two spacings per vertex is plenty.
const STEP = 2;

function build(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  // Brightness at a point, from its distance to the centre. Squared falloff so the middle of the
  // grid stays readable while the edge dissolves rather than ending on a hard rectangle.
  const fade = (x: number, z: number): number => {
    const d = Math.hypot(x, z) / FADE;
    return d >= 1 ? 0 : (1 - d) * (1 - d);
  };
  const push = (x1: number, z1: number, x2: number, z2: number) => {
    const a = fade(x1, z1), b = fade(x2, z2);
    if (a <= 0.001 && b <= 0.001) return;   // wholly outside the fade — never built, never drawn
    // Very slightly above the floor plane — see note 1 in the header. In normalised units this is
    // 0.001 SPACINGS, and because the group's Y scale stays 1 it is 1 mm on screen at every scale.
    pos.push(x1, 0.001, z1, x2, 0.001, z2);
    c.copy(LINE_COLOR).multiplyScalar(a); col.push(c.r, c.g, c.b);
    c.copy(LINE_COLOR).multiplyScalar(b); col.push(c.r, c.g, c.b);
  };
  for (let i = -EXTENT; i <= EXTENT; i++) {
    for (let t = -EXTENT; t < EXTENT; t += STEP) {
      const t2 = Math.min(t + STEP, EXTENT);
      push(i, t, i, t2);   // along Z
      push(t, i, t2, i);   // along X
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// ONE unit lattice, shared by the three families and kept for the life of the app (nothing about it
// depends on the scene). Deliberately not disposed on unmount: a remount would get a disposed buffer.
let lattice: THREE.BufferGeometry | null = null;
const latticeGeometry = (): THREE.BufferGeometry => (lattice ??= build());

// THE LIVE GRID, solvable for ANY camera (plans/3d-workbench.md Phase 2): the multi-view renderer
// re-solves it for each view right before drawing that view, so every pane gets a ruler scaled to ITS
// camera and lying on ITS plane. A single view calls it once per frame from GroundGrid's own useFrame —
// exactly what it did inline before. One grid exists (one <Simulator3D>, guarded), so module state is safe.
let liveLines: THREE.Group | null = null;
// Last solve's section, for the hysteresis band that stops a slow dolly blinking the whole floor between
// two decades. Module state, not React: this changes at pointer rate and must never re-render.
let liveSection = 0;

export function applyGrid(camera: THREE.Camera, heightPx: number): void {
  const g = liveLines;
  if (!g) return;
  // Solved in GRID space: on a flat side view the grid lies on that view's plane (gridSpace.ts).
  const f = solveGridFrame(gridCamera(camera), heightPx, liveSection);
  if (!f) { setGridFrame(null); g.visible = false; return; }
  g.visible = true;
  liveSection = f.section;
  setGridFrame(f);
  const fams = gridFamilies(f.pxPerMetre);
  g.children.forEach((child, i) => {
    const line = child as THREE.LineSegments;
    const fam = fams[i];
    const mat = line.material as THREE.LineBasicMaterial;
    if (!fam || fam.alpha <= 0.002) { line.visible = false; return; }
    line.visible = true;
    mat.opacity = LINE_OPACITY * fam.alpha;
    line.scale.set(fam.spacing, 1, fam.spacing);        // NEVER setScalar — see note 1 in the header
    // Follows the view, snapped to a whole spacing OF THIS FAMILY: every line stays on a round world
    // coordinate, and the finest family re-snaps in fine steps.
    line.position.set(Math.round(f.refX / fam.spacing) * fam.spacing, 0, Math.round(f.refZ / fam.spacing) * fam.spacing);
  });
}

export const GroundGrid: React.FC = () => {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    liveLines = ref.current;
    return () => { if (liveLines === ref.current) liveLines = null; };
  }, []);

  useFrame(({ camera, size }) => {
    if (!ref.current) return;
    liveLines = ref.current;
    applyGrid(camera, size.height);
  });

  // Stop the labels the moment the grid does. Without this the numbers freeze over a live viewport,
  // which reads as a renderer fault rather than as a hidden grid.
  useEffect(() => () => setGridFrame(null), []);

  return (
    // Never a pick target: it is a reference, and a full-floor pick plane would swallow every click
    // meant for the rig standing on it — the failure PlacementPlane's header describes.
    // `frustumCulled={false}` was already right and is load-bearing: the families MOVE, so three's
    // cached bounding spheres would be tested against stale world bounds.
    <group ref={ref}>
      {[0, 1, 2].map((i) => (
        <lineSegments key={i} geometry={latticeGeometry()} raycast={() => null} frustumCulled={false}>
          <lineBasicMaterial vertexColors transparent opacity={0} depthWrite={false} toneMapped={false} />
        </lineSegments>
      ))}
    </group>
  );
};
