// World-space multi-projector edge blending (Phase 2). Given each calibrated projector's dense
// per-pixel 3D map (projector pixel → world XYZ, from markerlessController), compute a per-projector
// blend map (alpha 0..1 over a low-res projector raster) that feathers overlaps so that, at every
// surface point lit by N projectors, the alphas sum to ~1 (a partition of unity — no seam, no
// brightness step). The blend is computed on the actual 3D surface (VIOSO-style), not in 2D camera
// space: each projector's footprint-edge distance ramps the weight, and world voxels associate the
// same surface point across projectors.
//
// Pure math (no three.js / IPC) so it unit-tests in plain node. The result feeds both NVAPI
// SetScanoutIntensity and ArtLux's GLSL blend.

export interface ProjectorBlendInput {
  surfaceId: string;
  raster: [number, number];                       // projector raster (projW, projH)
  denseMap: { proj: number[]; world: number[] };  // flat projector-pixel pairs + aligned world XYZ
}

export interface BlendMap {
  surfaceId: string;
  w: number; h: number;     // blend-map resolution (low-res; NVAPI/GLSL upsample)
  data: Float32Array;       // w*h alpha 0..1, row-major (0 = unlit by this projector)
  // Per-cell black-lift weight 0..1 (row-major, same w×h). 1 where this projector sees the *least*
  // overlap (its black floor must be raised most to match the N× black of the deepest overlap); 0 in
  // the most-overlapped region. Multiplied by the per-output blackLift magnitude at apply time. Absent
  // when there is only a single projector (no overlap → nothing to match).
  black?: Float32Array;
}

export interface BlendOptions {
  mapW?: number;   // blend-map width in cells (height follows the raster aspect); default 96
  voxel?: number;  // world voxel size for cross-projector association; default = sceneDiag/80
}

// 2-pass chamfer distance from each covered cell to the nearest uncovered cell / grid border (= the
// projector's footprint edge). Covered cells get their distance-to-edge; uncovered stay 0.
function footprintEdgeDistance(covered: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9, D1 = 1, D2 = Math.SQRT2;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = covered[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (d[i] === 0) continue;
    let m = d[i];
    m = Math.min(m, (x > 0 ? d[i - 1] : 0) + D1);
    m = Math.min(m, (y > 0 ? d[i - w] : 0) + D1);
    m = Math.min(m, (x > 0 && y > 0 ? d[i - w - 1] : 0) + D2);
    m = Math.min(m, (x < w - 1 && y > 0 ? d[i - w + 1] : 0) + D2);
    d[i] = m;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (d[i] === 0) continue;
    let m = d[i];
    m = Math.min(m, (x < w - 1 ? d[i + 1] : 0) + D1);
    m = Math.min(m, (y < h - 1 ? d[i + w] : 0) + D1);
    m = Math.min(m, (x < w - 1 && y < h - 1 ? d[i + w + 1] : 0) + D2);
    m = Math.min(m, (x > 0 && y < h - 1 ? d[i + w - 1] : 0) + D2);
    d[i] = m;
  }
  return d;
}

interface Grid { mapW: number; mapH: number; n: number; covered: Uint8Array; wx: Float64Array; wy: Float64Array; wz: Float64Array; dist: Float32Array }

export function computeBlendMaps(projectors: ProjectorBlendInput[], opts: BlendOptions = {}): BlendMap[] {
  if (!projectors.length) return [];
  // Default blend-map resolution adaptively from the sparsest projector's sample count, so cells stay
  // densely covered (~8 samples/cell) — too many cells vs samples leaves holes that fake footprint edges.
  const minSamples = Math.min(...projectors.map((p) => p.denseMap.proj.length / 2));
  const mapW = Math.max(8, opts.mapW ?? Math.min(80, Math.max(16, Math.round(Math.sqrt(minSamples / 8)))));

  // Scene bbox → default voxel size for cross-projector association.
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of projectors) {
    const W = p.denseMap.world;
    for (let i = 0; i < W.length; i += 3) for (let k = 0; k < 3; k++) { const v = W[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
  }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  const voxel = opts.voxel && opts.voxel > 0 ? opts.voxel : diag / 80;

  // Per-projector coverage grid: footprint, averaged world point per cell, edge distance.
  const grids: Grid[] = projectors.map((p) => {
    const [pw, ph] = p.raster;
    const mapH = Math.max(1, Math.round((mapW * ph) / Math.max(1, pw)));
    const n = mapW * mapH;
    const covered = new Uint8Array(n);
    const wx = new Float64Array(n), wy = new Float64Array(n), wz = new Float64Array(n);
    const cnt = new Uint32Array(n);
    const W = p.denseMap.world, P = p.denseMap.proj, m = P.length / 2;
    for (let i = 0; i < m; i++) {
      const cx = Math.min(mapW - 1, Math.max(0, Math.floor((P[i * 2] / pw) * mapW)));
      const cy = Math.min(mapH - 1, Math.max(0, Math.floor((P[i * 2 + 1] / ph) * mapH)));
      const c = cy * mapW + cx;
      covered[c] = 1; wx[c] += W[i * 3]; wy[c] += W[i * 3 + 1]; wz[c] += W[i * 3 + 2]; cnt[c]++;
    }
    for (let c = 0; c < n; c++) if (cnt[c]) { wx[c] /= cnt[c]; wy[c] /= cnt[c]; wz[c] /= cnt[c]; }
    // Morphological close: fill decode-dropout holes (uncovered cells well-surrounded by covered ones,
    // including the checkerboard gaps a sparse camera→projector mapping leaves) so they don't create
    // spurious interior footprint edges. Real boundaries (mostly-uncovered neighbourhood) stay edges.
    const closed = covered.slice();
    for (let y = 0; y < mapH; y++) for (let x = 0; x < mapW; x++) {
      const c = y * mapW + x;
      if (covered[c]) continue;
      let nb = 0, sx = 0, sy = 0, sz = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= mapW || ny >= mapH) continue;
        const nc = ny * mapW + nx;
        if (covered[nc]) { nb++; sx += wx[nc]; sy += wy[nc]; sz += wz[nc]; }
      }
      if (nb >= 4) { closed[c] = 1; wx[c] = sx / nb; wy[c] = sy / nb; wz[c] = sz / nb; }
    }
    return { mapW, mapH, n, covered: closed, wx, wy, wz, dist: footprintEdgeDistance(closed, mapW, mapH) };
  });

  // Associate covered cells across projectors by world voxel; track each projector's representative
  // (max) edge-distance in the voxel.
  const voxels = new Map<string, Map<number, { dRep: number; cells: number[] }>>();
  grids.forEach((g, pi) => {
    for (let c = 0; c < g.n; c++) {
      if (!g.covered[c]) continue;
      const key = `${Math.round(g.wx[c] / voxel)}_${Math.round(g.wy[c] / voxel)}_${Math.round(g.wz[c] / voxel)}`;
      let vm = voxels.get(key); if (!vm) { vm = new Map(); voxels.set(key, vm); }
      let e = vm.get(pi); if (!e) { e = { dRep: 0, cells: [] }; vm.set(pi, e); }
      e.cells.push(c); if (g.dist[c] > e.dRep) e.dRep = g.dist[c];
    }
  });

  // Alpha = this projector's representative distance / sum over projectors in the voxel → Σα = 1.
  const out = grids.map((g) => new Float32Array(g.n));
  for (const vm of voxels.values()) {
    let denom = 0; for (const e of vm.values()) denom += e.dRep;
    if (denom <= 0) { const k = vm.size; for (const [pi, e] of vm) for (const c of e.cells) out[pi][c] = 1 / k; continue; }
    for (const [pi, e] of vm) { const a = e.dRep / denom; for (const c of e.cells) out[pi][c] = a; }
  }

  // Black-lift weight: per voxel, overlap count = vm.size. A cell covered by this projector needs to
  // fake the black of the (maxOverlap − overlapHere) projectors that don't reach it, normalized so the
  // least-overlapped region = 1 and the deepest overlap = 0. Only meaningful with ≥2 projectors.
  let maxOverlap = 1;
  for (const vm of voxels.values()) if (vm.size > maxOverlap) maxOverlap = vm.size;
  const black = grids.map((g) => new Float32Array(g.n));
  if (maxOverlap > 1) {
    const span = maxOverlap - 1;
    for (const vm of voxels.values()) {
      const wgt = (maxOverlap - vm.size) / span; // 0 at deepest overlap, 1 at single coverage
      for (const [pi, e] of vm) for (const c of e.cells) black[pi][c] = wgt;
    }
  }

  return grids.map((g, pi) => ({
    surfaceId: projectors[pi].surfaceId, w: g.mapW, h: g.mapH, data: out[pi],
    ...(maxOverlap > 1 ? { black: black[pi] } : {}),
  }));
}
