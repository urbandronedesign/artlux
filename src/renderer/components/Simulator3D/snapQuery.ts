// OBJECT SNAPS — the r3f/three adapter (plans/3d-workbench.md Phase 3). The rules live in
// services/snap3d.ts; this file finds the CANDIDATES near the cursor in one pane's camera:
//   - FACE: the surface under the cursor, with its normal (one raycast).
//   - END / MID / EDGE: the FEATURE edges of the mesh under the cursor near the hit — feature edges, not
//     triangle edges, so the diagonal of a triangulated quad is never offered as an edge (three's
//     EdgesGeometry at 20°). Ends are their endpoints, Mid their middles, Edge the nearest point on one.
//   - CENTRE: the middle of each model's / screen's bounds.
//   - FIXTURE: both ends and the centre of every fixture (snap3d.fixtureSnapPoints).
//
// COST, because a venue GLB can be millions of triangles and this runs at pointer rate during a drag:
//   - Per-geometry data (the feature edges, a BVH for the raycast) is built ONCE, in an idle callback,
//     never in the pointer handler. Until it exists that mesh offers nothing but what a cheap raycast
//     can (small meshes) — a snap that arrives a moment late beats a frame that stalls.
//   - Only the mesh UNDER the cursor is searched for edges, and only near the hit.
// Point candidates on a mesh are occlusion-tested (a corner on the far side of a wall must not win —
// vertexSnap.ts measured that failure), the nearest few only.
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import type { Fixture } from '../../types';
import { computeLedPositions } from '../../services/led3dLayout';
import {
  CAPTURE_PX, closestOnSegment, fixtureSnapPoints, pickBest, toggleOf,
  type OsnapKind, type SnapCandidate, type SnapPointKind,
} from '../../services/snap3d';

// ── Per-geometry data, built off the pointer path ──────────────────────────────────────────────────
interface Features { edges: Float32Array | null; bvh: boolean }
const cache = new WeakMap<THREE.BufferGeometry, Features | 'pending'>();
/** Above this a mesh gets no edge snaps (face + centre still work). */
const MAX_EDGE_TRIS = 400_000;
/** Below this a mesh may be raycast plainly while its BVH is still being built. */
const PLAIN_RAYCAST_TRIS = 60_000;

const idle: (f: () => void) => void = (f) => {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(f, { timeout: 500 }); else setTimeout(f, 0);
};
const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;

function features(g: THREE.BufferGeometry): Features | null {
  const c = cache.get(g);
  if (c === 'pending') return null;
  if (c) return c;
  cache.set(g, 'pending');
  idle(() => {
    let edges: Float32Array | null = null;
    let bvh = false;
    try {
      if (triCount(g) <= MAX_EDGE_TRIS) edges = (new THREE.EdgesGeometry(g, 20).attributes.position.array as Float32Array).slice();
      const gb = g as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!gb.boundsTree && g.attributes.position) gb.boundsTree = new MeshBVH(g);
      bvh = !!gb.boundsTree;
    } catch { /* an odd geometry: face snaps only */ }
    cache.set(g, { edges, bvh });
  });
  return null;
}

/** Start the background build for every mesh under `root` — called when a drag begins, so the data
 *  is usually ready by the time the pointer reaches a target. */
export function warmSnapData(root: THREE.Object3D): void {
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) features(m.geometry); });
}

// ── The query ──────────────────────────────────────────────────────────────────────────────────────
export interface SnapQuery {
  camera: THREE.Camera;
  /** Pointer in the pane, css px, and the pane's size. */
  x: number; y: number; w: number; h: number;
  /** Model / screen groups (userData.modelId) to search. */
  models: THREE.Object3D[];
  fixtures: Fixture[];
  kinds: OsnapKind[];
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _p = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _local = new THREE.Vector3();
const _inv = new THREE.Matrix4();

function toPx(v: THREE.Vector3, q: SnapQuery): number | null {
  _p.copy(v).project(q.camera);
  if (_p.z > 1 || _p.z < -1) return null;
  return Math.hypot((_p.x + 1) / 2 * q.w - q.x, (1 - _p.y) / 2 * q.h - q.y);
}

/** World metres per css px at a point, in this camera. */
function worldPerPx(cam: THREE.Camera, at: THREE.Vector3, h: number): number {
  const o = cam as THREE.OrthographicCamera;
  if (o.isOrthographicCamera) return (o.top - o.bottom) / (o.zoom || 1) / h;
  const p = cam as THREE.PerspectiveCamera;
  const d = Math.max(1e-3, _c.copy(at).applyMatrix4(cam.matrixWorldInverse).z * -1);
  return (2 * d * Math.tan(((p.fov ?? 50) * Math.PI) / 360)) / h;
}

const meshesOf = (roots: THREE.Object3D[]): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  for (const r of roots) r.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.visible && m.geometry && !(m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) out.push(m);
  });
  return out;
};

/** The first surface under the pointer among these meshes — BVH when built, plain when small. */
function raycastFirst(meshes: THREE.Mesh[]): THREE.Intersection | null {
  const hits: THREE.Intersection[] = [];
  for (const m of meshes) {
    const f = features(m.geometry);
    if (f?.bvh) acceleratedRaycast.call(m, _ray, hits);
    else if (triCount(m.geometry) <= PLAIN_RAYCAST_TRIS) m.raycast(_ray, hits);
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0];
}

const ledCache = new WeakMap<Fixture, ReturnType<typeof fixtureSnapPoints>>();
function fixturePoints(f: Fixture) {
  if (!ledCache.has(f)) ledCache.set(f, fixtureSnapPoints(computeLedPositions(f)));
  return ledCache.get(f)!;
}

/** Every candidate near the cursor (unranked). Exposed for the base point, which ranks its own way. */
export function snapCandidates(q: SnapQuery): SnapCandidate[] {
  const on = new Set(q.kinds);
  const out: SnapCandidate[] = [];
  const push = (kind: SnapPointKind, point: THREE.Vector3, normal?: THREE.Vector3) => {
    if (!on.has(toggleOf(kind))) return;
    const px = kind === 'face' ? 0 : toPx(point, q);
    if (px == null || px > CAPTURE_PX) return;
    out.push({ kind, point: point.clone(), px, normal });
  };

  // Fixtures — cheap, no raycast.
  if (on.has('fixture')) for (const f of q.fixtures) {
    const fp = fixturePoints(f);
    if (!fp) continue;
    for (const e of fp.ends) push('fixtureEnd', e);
    push('fixtureCenter', fp.centre);
  }

  // Centres of models and screens — from bounds already on the geometries (no vertex walk).
  if (on.has('center')) for (const m of q.models) {
    const box = new THREE.Box3().setFromObject(m);
    if (!box.isEmpty()) push('center', box.getCenter(new THREE.Vector3()));
  }

  // The surface under the cursor, and its feature edges.
  if (!(on.has('face') || on.has('end') || on.has('mid') || on.has('edge')) || !q.models.length) return out;
  _ndc.set((q.x / q.w) * 2 - 1, -(q.y / q.h) * 2 + 1);
  _ray.setFromCamera(_ndc, q.camera);
  const meshes = meshesOf(q.models);
  const hit = raycastFirst(meshes);
  if (!hit) return out;
  const mesh = hit.object as THREE.Mesh;
  if (hit.face) {
    const n = hit.face.normal.clone().transformDirection(mesh.matrixWorld);
    push('face', hit.point, n);
  }
  const f = features(mesh.geometry);
  if (!f?.edges || !(on.has('end') || on.has('mid') || on.has('edge'))) return out;

  // Search radius in the mesh's LOCAL units around the hit: the capture radius at the hit's depth,
  // divided by the mesh's smallest scale so a scaled-down model is not searched too narrowly.
  const s = new THREE.Vector3(); mesh.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
  const minS = Math.max(1e-9, Math.min(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z)));
  const R = (CAPTURE_PX * 1.5 * worldPerPx(q.camera, hit.point, q.h)) / minS;
  _inv.copy(mesh.matrixWorld).invert();
  _local.copy(hit.point).applyMatrix4(_inv);
  const E = f.edges;
  const pts: SnapCandidate[] = [];
  const wp = (v: THREE.Vector3) => v.clone().applyMatrix4(mesh.matrixWorld);
  for (let i = 0; i < E.length; i += 6) {
    _a.set(E[i], E[i + 1], E[i + 2]); _b.set(E[i + 3], E[i + 4], E[i + 5]);
    closestOnSegment(_local, _a, _b, _c);
    if (_c.distanceTo(_local) > R) continue;
    if (on.has('end')) { if (_a.distanceTo(_local) <= R) pts.push({ kind: 'end', point: wp(_a), px: 0 }); if (_b.distanceTo(_local) <= R) pts.push({ kind: 'end', point: wp(_b), px: 0 }); }
    if (on.has('mid')) pts.push({ kind: 'mid', point: wp(_a.clone().add(_b).multiplyScalar(0.5)), px: 0 });
    if (on.has('edge')) pts.push({ kind: 'edge', point: wp(_c), px: 0 });
  }
  // On screen, nearest first; then only VISIBLE ones (the nearest few are tested).
  for (const c of pts) c.px = toPx(c.point, q) ?? Infinity;
  const near = pts.filter((c) => c.px <= CAPTURE_PX).sort((a, b) => a.px - b.px);
  let tested = 0;
  for (const c of near) {
    if (tested >= 8) break;
    tested++;
    if (visible(c.point, q.camera, meshes)) out.push(c);
  }
  return out;
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
function visible(p: THREE.Vector3, cam: THREE.Camera, meshes: THREE.Mesh[]): boolean {
  const o = cam as THREE.OrthographicCamera;
  if (o.isOrthographicCamera) {
    // Parallel rays: from far back along the view direction to the point.
    cam.getWorldDirection(_d);
    _o.copy(p).addScaledVector(_d, -1000);
  } else _o.setFromMatrixPosition(cam.matrixWorld);
  const dist = _o.distanceTo(p);
  _ray.set(_o, _d.copy(p).sub(_o).normalize());
  _ray.far = dist;
  const hit = raycastFirst(meshes);
  _ray.far = Infinity;
  return !hit || hit.distance >= dist - (dist * 1e-3 + 1e-4);
}

/**
 * What a PRESS lands on, among the model meshes and the extra pickables (fixture bodies), with the
 * instance index for instanced ones. Used by ObjectDrag to decide whether a press grabbed something in
 * the selection. A FIXTURE ANYWHERE UNDER THE POINTER WINS over a model or screen nearer the camera —
 * pickPriority.ts's rule, for the same reason: a screen or floor is a big plane and a bar lies on (or
 * just under) it, so the plane is almost always nearer. Measured: the example's wall strip sits 34 mm
 * below the floor projection, and every press on it landed on the floor.
 */
export function pressHit(camera: THREE.Camera, x: number, y: number, w: number, h: number,
                         models: THREE.Object3D[], extra: THREE.Object3D[]): THREE.Intersection | null {
  _ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  const a = raycastFirst(meshesOf(models));
  const b = extra.length ? _ray.intersectObjects(extra, false)[0] ?? null : null;
  return b ?? a;
}

/** The ray through a pane point — for the drag's fallback plane. */
export function pointerRay(camera: THREE.Camera, x: number, y: number, w: number, h: number): THREE.Ray {
  _ndc.set((x / w) * 2 - 1, -(y / h) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  return _ray.ray.clone();
}

/** The ONE snap under the cursor (snap3d.pickBest), or null. */
export function querySnap(q: SnapQuery): SnapCandidate | null {
  return pickBest(snapCandidates(q));
}
