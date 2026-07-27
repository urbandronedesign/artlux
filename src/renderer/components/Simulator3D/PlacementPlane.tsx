import React from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { DEFAULT_TRIM_HEIGHT } from '../../services/led3dDefaults';

// The invisible floor you click to place a light fixture.
//
// Mounted ONLY while a placement is armed — an always-present pick plane would sit in front of every
// model in the venue and swallow clicks meant for them, which is the same "a big flat thing covers
// the thing you were aiming at" failure pickPriority.ts exists to fix. Here it is the opposite of a
// problem: while armed, swallowing the click IS the job.
//
// ── WHY THE CLICK CHOOSES A FLOOR POSITION, NOT THE FIXTURE'S POSITION ───────────────────────
// A moving head is rigged on a truss, not stood on the floor, so dropping it at the raycast hit
// point would put every fixture on the ground. The click therefore picks the point on the floor the
// light should be OVER, and the fixture hangs at `DEFAULT_TRIM_HEIGHT` above it — which is how you
// would describe a rig out loud ("that one goes over there"). The height is then editable like any
// other: the gizmo, the 3D layout fields and Arrange all still apply.
export const PlacementPlane: React.FC<{ onPlace: (p: { x: number; y: number; z: number }) => void }> =
({ onPlace }) => (
  <mesh
    // Flat on the ground plane. Slightly below zero so it never z-fights the grid it sits under.
    position={[0, -0.001, 0]}
    rotation={[-Math.PI / 2, 0, 0]}
    // Big enough to cover any realistic venue, so a click never falls off the edge with nothing
    // under it — a click that silently does nothing is worse than one that lands imprecisely.
    onClick={(e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      onPlace({ x: e.point.x, y: DEFAULT_TRIM_HEIGHT, z: e.point.z });
    }}
  >
    <planeGeometry args={[200, 200]} />
    {/* Invisible but still raycastable: `visible={false}` would remove it from the raycast too. */}
    <meshBasicMaterial transparent opacity={0} depthWrite={false} />
  </mesh>
);
