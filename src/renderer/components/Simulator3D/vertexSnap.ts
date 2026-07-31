import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';

// VERTEX SNAPPING for placing a calibration anchor on the venue.
//
// An anchor is one half of a correspondence: the operator must click the SAME physical point in the
// camera image and on the model. In the camera image that point is always a feature you can see — a
// corner, an edge junction — and the loupe gets you onto it to the pixel. On the model, the raw
// ray/surface intersection lands wherever the ray happens to cross the triangle: a millimetre off the
// corner, on a face, at a point with no counterpart in the photo. So the two halves of the pair are
// systematically not the same point, and that error goes straight into solvePnP as reprojection
// residual that no amount of care in the camera view can remove.
//
// TWO RADII, because one was unusable. The first version only ever considered the vertices of the
// triangle the ray happened to hit, and only showed the preview once the cursor was ALREADY inside the
// snap radius — so it could not help you find a vertex, only confirm one you had already hit by luck,
// and any corner whose approach crossed a different triangle (or left the silhouette entirely) simply
// never lit up. Now the candidate is the nearest vertex ANYWHERE on the hit mesh, it previews from far
// enough away to aim by, and it captures the click only when you are close.

/** Within this screen radius (css px) a vertex captures the click. */
export const SNAP_PX = 22;
/** Within this larger radius the candidate is shown, dimmed, so you can steer onto it. */
export const PREVIEW_PX = 70;

const _v = new THREE.Vector3();
const _proj = new THREE.Vector3();

export interface SnapResult {
  point: [number, number, number];
  /** True when the returned point is a mesh vertex rather than the raw surface intersection. */
  snapped: boolean;
}

/** Project a world point to css pixels. Returns null when it is behind the camera. */
function toScreen(p: THREE.Vector3, camera: THREE.Camera, w: number, h: number): [number, number] | null {
  _proj.copy(p).project(camera);
  if (_proj.z > 1) return null; // behind the near plane — not on screen at all
  return [(_proj.x * 0.5 + 0.5) * w, (-_proj.y * 0.5 + 0.5) * h];
}

// ── Unique vertices per geometry ──────────────────────────────────────────────────────────────
// Cached because it is pure geometry: it cannot change unless the GLB is reloaded, and reloading
// builds a new BufferGeometry (hence a WeakMap, which also lets a disposed geometry's entry go).
//
// DEDUPLICATED because a cube exported for flat shading carries three copies of every corner, one per
// adjoining face — the same point, and without collapsing them the "nearest vertex" search would do
// three times the work to reach the same answer. Quantised to 0.1 mm, which merges the duplicates a
// exporter emits without merging two corners that are genuinely distinct.
//
// Above the cap we do not build a list at all and the caller falls back to the hit triangle: a
// scanned venue can carry millions of vertices, and walking them on every pointer move would cost more
// than the precision it buys.
const MAX_UNIQUE = 2000;
const uniqueCache = new WeakMap<THREE.BufferGeometry, Float32Array | null>();

function uniqueVertices(geom: THREE.BufferGeometry): Float32Array | null {
  const cached = uniqueCache.get(geom);
  if (cached !== undefined) return cached;
  const pos = geom.attributes?.position as THREE.BufferAttribute | undefined;
  let out: Float32Array | null = null;
  if (pos) {
    const seen = new Set<string>();
    const acc: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      acc.push(x, y, z);
      if (seen.size > MAX_UNIQUE) { uniqueCache.set(geom, null); return null; }
    }
    out = new Float32Array(acc);
  }
  uniqueCache.set(geom, out);
  return out;
}

interface Candidate { v: THREE.Vector3; dist: number }

/**
 * The mesh vertex nearest the cursor ON SCREEN, with its screen distance — or null when this hit
 * cannot be snapped (an instanced/skinned/morphed mesh, whose drawn vertices are not the ones in the
 * position attribute, so a vertex read from it would be a point in space with nothing visible at it).
 * Returning null is always safe: the caller falls back to the exact surface point.
 */
function bestVertex(e: ThreeEvent<MouseEvent>, w: number, h: number): Candidate | null {
  if (e.instanceId != null || !w || !h) return null;
  const mesh = e.object as THREE.Mesh;
  if ((mesh as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) return null;
  const geom = mesh.geometry as THREE.BufferGeometry | undefined;
  const pos = geom?.attributes?.position as THREE.BufferAttribute | undefined;
  if (!geom || !pos || geom.morphAttributes?.position?.length) return null;

  const hitScreen = toScreen(e.point, e.camera, w, h);
  if (!hitScreen) return null;
  const camPos = e.camera.position;
  const hitDist = camPos.distanceTo(e.point);
  // Reject anything markedly deeper than the surface under the cursor. Searching the whole mesh
  // otherwise lets a corner on the FAR side — which often projects within a few pixels of the near one
  // on a box — capture a click aimed at the corner you can actually see. A silhouette corner sits at
  // essentially the hit depth; a back corner is far past it.
  const maxDist = hitDist * 1.2 + 1e-6;

  let bestV: THREE.Vector3 | null = null;
  let bestD = Infinity;
  const consider = (x: number, y: number, z: number): void => {
    _v.set(x, y, z);
    mesh.localToWorld(_v);
    if (camPos.distanceTo(_v) > maxDist) return;
    const s = toScreen(_v, e.camera, w, h);
    if (!s) return;
    const d = Math.hypot(s[0] - hitScreen[0], s[1] - hitScreen[1]);
    if (d < bestD) { bestD = d; bestV = (bestV ?? new THREE.Vector3()).copy(_v); }
  };

  const uniq = uniqueVertices(geom);
  if (uniq) {
    for (let i = 0; i < uniq.length; i += 3) consider(uniq[i], uniq[i + 1], uniq[i + 2]);
  } else if (e.face) {
    for (const idx of [e.face.a, e.face.b, e.face.c]) consider(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
  }
  return bestV ? { v: bestV, dist: bestD } : null;
}

/**
 * The point a click should place: the nearest vertex when one is within SNAP_PX of the cursor on
 * screen, otherwise the exact surface intersection. Alt bypasses snapping entirely.
 */
export function snapToVertex(e: ThreeEvent<MouseEvent>, width: number, height: number): SnapResult {
  const raw: [number, number, number] = [e.point.x, e.point.y, e.point.z];
  if (e.nativeEvent?.altKey) return { point: raw, snapped: false };
  const b = bestVertex(e, width, height);
  if (!b || b.dist > SNAP_PX) return { point: raw, snapped: false };
  return { point: [b.v.x, b.v.y, b.v.z], snapped: true };
}

// ── Hover preview ─────────────────────────────────────────────────────────────────────────────
// WHICH vertex you are about to snap to must be visible BEFORE you commit the click — otherwise the
// anchor lands somewhere you did not choose and you find out by reading coordinates afterwards.
// A render-free channel on purpose: this updates at pointer rate, and putting it in React state would
// re-render the whole 3D tree on every mouse move (see the App-state/re-render trap in CLAUDE.md).
// SnapCursor polls it in its own useFrame.
export interface SnapHover { point: THREE.Vector3; armed: boolean }

let hover: SnapHover | null = null;
export function setSnapHover(v: SnapHover | null): void { hover = v; }
export function getSnapHover(): SnapHover | null { return hover; }

/** Update the preview from a pointer-move over a pickable surface. `armed` mirrors snapToVertex's gate. */
export function updateSnapHover(e: ThreeEvent<MouseEvent>, width: number, height: number): void {
  if (e.nativeEvent?.altKey) { hover = null; return; }
  const b = bestVertex(e, width, height);
  hover = b && b.dist <= PREVIEW_PX ? { point: b.v.clone(), armed: b.dist <= SNAP_PX } : null;
}
