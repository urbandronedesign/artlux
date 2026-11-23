import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { AxisArms } from './AxisTriad';
import { getGridFrame, GNOMON_PX } from './gridScale';

// WHERE (0,0,0) IS — and, at the same time, how long one grid cell is.
//
// The scene had no mark for its own origin. Every number an operator types is relative to it
// (Fixture.position3D, SceneModel.position, a projector's solved translation), and none of them could
// be sanity-checked by looking, because the point they are measured from was invisible.
//
// THE ARMS ARE EXACTLY ONE SECTION LONG, which is what makes this more than a marker: it is a ruler
// standing in the scene. The floor grid re-steps as you zoom (gridScale.ts), and because the gnomon
// takes its length from the same solved frame, "one arm" always means "one counted grid line to the
// next" — the interval the labels are numbering. That is the property worth documenting in the help
// entry, because nobody discovers it on their own.
//
// IT IS NOT PARENTED INTO THE GRID, for two separate reasons, either of which alone is decisive:
//   1. The grid's group carries a NON-UNIFORM scale, (s, 1, s), to protect its 1 mm lift off the floor
//      from shrinking into a z-fight. Riding that would leave the Y arm at 1/section of its intended
//      length — a ruler that is silently wrong on exactly one axis.
//   2. The grid FOLLOWS the view. The gnomon must not: it is the one thing left in the scene that
//      still says where the world origin actually is.
//
// IT DRAWS ON TOP (AxisArms `overlay`), and that reversed the first decision. Depth-testing it is the
// honest choice in the abstract: it marks a point in space, and drawing it through a wall misreports
// where that point is. Running it showed what the abstract argument left out — in this app the world
// origin is normally ON the venue floor, and a venue floor is normally a plane modelled at y = 0, so
// the gnomon spent its life buried a millimetre under the one object guaranteed to cover it, in
// exactly the case you reach for it. It is translucent instead, which says "overlay" without
// pretending to be geometry.

// Rod radius as a fraction of arm length. The corner widget uses 4.4% because it fills its own tiny
// viewport; in the scene that reads as a fat rod sitting exactly where GLB pivots and placement clicks
// land, so this is a good deal slimmer, and carries no sphere caps at all.
const RADIUS_FRAC = 0.012;

// ONE SIZE ON SCREEN (2026-11-23). Its arms were ONE SECTION long, so the gnomon jumped whenever the
// grid stepped — the same pop the grid had. They are now a constant on-screen length, from the same
// px-per-metre the grid fades by, so it grows and shrinks smoothly with the zoom. The grid lines and the
// numbers are the ruler now; this marks where the origin is and which way the axes run.
let liveGnomon: THREE.Group | null = null;
/** Size the gnomon for a given density — the four-view renderer calls this per pane. */
export function applyGnomon(pxPerMetre: number | null): void {
  if (!liveGnomon) return;
  liveGnomon.scale.setScalar(pxPerMetre && pxPerMetre > 0 ? GNOMON_PX / pxPerMetre : 0);
}

export const OriginGnomon: React.FC = () => {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => { liveGnomon = ref.current; return () => { if (liveGnomon === ref.current) liveGnomon = null; }; }, []);

  useFrame(() => {
    if (!ref.current) return;
    liveGnomon = ref.current;
    // No frame published this tick (the grid solved nothing) — collapse rather than sit at a stale
    // size. A gnomon a hundred metres long across a 20 cm prop is worse than no gnomon.
    applyGnomon(getGridFrame()?.pxPerMetre ?? null);
  });

  // Starts collapsed, not at unit scale: the first useFrame is a frame away, and a 1-unit gnomon for
  // that frame is a coloured cross across the viewport every time the scene mounts — the same reason
  // AnchorMarker starts at 0.0001.
  return (
    <group ref={ref} scale={0}>
      <AxisArms len={1} radius={RADIUS_FRAC} segments={6} overlay />
    </group>
  );
};
