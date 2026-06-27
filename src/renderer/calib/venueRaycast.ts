import * as THREE from 'three';

// Programmatic batch raycasting against the loaded venue meshes for the markerless calibration
// pipeline. Each ModelObject registers its world-space container group here; the markerless controller
// casts a camera ray per decoded camera pixel against these to assign a 3D venue point (replacing the
// printed board as the metric reference). Separate from R3F's interactive click-raycast (e.point) so
// we can fire thousands of rays in one shot without UI events.

const groups = new Map<string, THREE.Object3D>();
const raycaster = new THREE.Raycaster();
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

export function registerVenueMesh(id: string, obj: THREE.Object3D): void { groups.set(id, obj); }
export function unregisterVenueMesh(id: string): void { groups.delete(id); }
export function hasVenueMeshes(): boolean { return groups.size > 0; }

// Intersect one ray against all registered meshes → nearest world-space hit (assumes world matrices
// are current — callers update them once per batch).
function cast(origin: readonly [number, number, number], dir: readonly [number, number, number]): [number, number, number] | null {
  _o.set(origin[0], origin[1], origin[2]);
  _d.set(dir[0], dir[1], dir[2]).normalize();
  raycaster.set(_o, _d);
  let best: THREE.Intersection | null = null;
  for (const g of groups.values()) {
    const hits = raycaster.intersectObject(g, true);
    if (hits.length && (!best || hits[0].distance < best.distance)) best = hits[0];
  }
  return best ? [best.point.x, best.point.y, best.point.z] : null;
}

// Single ray (updates world matrices first).
export function raycastVenue(origin: readonly [number, number, number], dir: readonly [number, number, number]): [number, number, number] | null {
  if (!groups.size) return null;
  for (const g of groups.values()) g.updateMatrixWorld(true);
  return cast(origin, dir);
}

// Many rays — updates world matrices ONCE, then casts each. Returns a hit (or null) per input ray,
// index-aligned. Use this for the dense decode → venue sampling.
export function raycastVenueBatch(
  rays: { origin: [number, number, number]; dir: [number, number, number] }[],
): ([number, number, number] | null)[] {
  if (!groups.size) return rays.map(() => null);
  for (const g of groups.values()) g.updateMatrixWorld(true);
  return rays.map((r) => cast(r.origin, r.dir));
}
