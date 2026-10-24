// World-space multi-projector edge blending (Phase 2). Given each calibrated projector's dense
// per-pixel 3D map (projector pixel → world XYZ, from markerlessController), compute a per-projector
// blend map (alpha 0..1 over a low-res projector raster) that feathers overlaps so that, at every
// surface point lit by N projectors, the alphas sum to ~1 (a partition of unity — no seam, no
// brightness step). The blend is computed on the actual 3D surface (VIOSO-style), not in 2D camera
// space: each projector's distance to its own image frame ramps the weight, and world voxels associate the
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

// THE BLEND WEIGHT: how far a cell is from the edge of this projector's IMAGE (its raster frame), as the
// product of its horizontal and vertical distances to that frame (in cells).
//
// It used to be the distance to the edge of the projector's lit FOOTPRINT. On a wall the projector
// fills, the two are the same thing, which is why the flat-wall tests passed. On a real screen they
// are not: a 1.8 m screen inside a 2 m tall image puts the footprint's top and bottom edges ~4 cells
// from everything, so that distance capped every weight and two side-by-side projectors split the
// whole overlap ~50/50 instead of cross-fading — measured on the multi-projector template's curved
// panorama as 1.45x the light across the overlap and a dark dip at its edge. Those silhouette edges
// are not seams: no projector continues past them, so they must not shape the fade at all.
//
// Distance to the FRAME is what goes to 0 exactly where this projector's light stops. The PRODUCT is
// what keeps it to one direction: two projectors side by side share (nearly) the same vertical factor,
// which cancels in the normalisation, leaving a pure horizontal cross-fade — and vice versa for a stack.
// Known limit, same as before for that case: an occlusion shadow INSIDE a projector's image is not
// feathered (the old footprint distance did feather it, at the cost of the bug above).
function frameWeight(w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    d[y * w + x] = Math.min(x + 0.5, w - x - 0.5) * Math.min(y + 0.5, h - y - 0.5);
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
    return { mapW, mapH, n, covered: closed, wx, wy, wz, dist: frameWeight(mapW, mapH) };
  });

  // ── The association voxel is sized like a CELL, not like the room ──────────────────────────────
  // The voxel exists to decide "these two projectors light the same spot", so the only scale that
  // matters is how much world a blend-map cell covers. A voxel fixed to the scene diagonal was right
  // only by accident at the default resolution: raise mapW and the cells shrink while the voxel does
  // not, so association starts smearing over several cells and the seam error stops improving — the
  // residual fell only 1.4x for a 4x resolution increase. Tied to the cell, it falls as it should.
  // Measured across both regimes in scripts/test-blend.ts.
  const cellWorld = (): number => {
    let sum = 0, n = 0;
    for (const g of grids) {
      for (let y = 0; y < g.mapH; y++) {
        for (let x = 1; x < g.mapW; x++) {
          const c = y * g.mapW + x, p = c - 1;
          if (!g.covered[c] || !g.covered[p]) continue;
          sum += Math.hypot(g.wx[c] - g.wx[p], g.wy[c] - g.wy[p], g.wz[c] - g.wz[p]);
          n++;
        }
      }
    }
    return n ? sum / n : diag / 80;
  };
  // 1.0 cell: the 3×3×3 dilation then reaches exactly one cell in each direction, which is what it
  // takes to bridge the half-cell offset between two projectors' grids and no more.
  const voxel = opts.voxel && opts.voxel > 0 ? opts.voxel : Math.max(1e-6, cellWorld());

  // Associate covered cells across projectors by world voxel; track each projector's representative
  // (max) edge-distance in the voxel.
  const voxels = new Map<string, Map<number, { dRep: number; cells: number[] }>>();
  const coords = new Map<string, [number, number, number]>(); // key → integer voxel coords (for dilation)
  grids.forEach((g, pi) => {
    for (let c = 0; c < g.n; c++) {
      if (!g.covered[c]) continue;
      const ix = Math.round(g.wx[c] / voxel), iy = Math.round(g.wy[c] / voxel), iz = Math.round(g.wz[c] / voxel);
      const key = `${ix}_${iy}_${iz}`;
      let vm = voxels.get(key); if (!vm) { vm = new Map(); voxels.set(key, vm); coords.set(key, [ix, iy, iz]); }
      let e = vm.get(pi); if (!e) { e = { dRep: 0, cells: [] }; vm.set(pi, e); }
      e.cells.push(c); if (g.dist[c] > e.dRep) e.dRep = g.dist[c];
    }
  });

  // ── DILATE the association by one voxel before dividing ────────────────────────────────────────
  // Two projectors do not share a cell grid: at the same physical point their cell centroids sit
  // roughly half a cell apart, so they routinely land in ADJACENT voxels and — with a hard hash —
  // never meet. Such a cell then looks single-covered and keeps alpha 1 in the middle of a seam,
  // which on the wall is a bright band exactly where the blend was supposed to disappear. (Observed:
  // an otherwise clean ramp with isolated 1.000 cells inside the overlap; scripts/test-blend.ts.)
  //
  // So a voxel's DENOMINATOR is taken over its 3×3×3 neighbourhood: if a projector lights anywhere
  // nearby, it is part of the division here. Two adjacent voxels then see the same neighbours and
  // agree. This does not let a distant projector steal share — a projector whose footprint merely
  // touches the neighbourhood has an edge-distance near 0 there, so it contributes ~0 to the sum.
  // MEAN over the neighbourhood, not max. The edge-distance field is locally linear across a seam, and
  // the mean of a linear field over a symmetric neighbourhood is its value at the centre — unbiased.
  // Taking the max instead adds most of a cell to every projector, and because the two projectors are
  // evaluated in DIFFERENT voxels those inflations do not cancel: it put a uniform +9.6% across the
  // whole overlap (a bright band, just a smooth one). Measured in scripts/test-blend.ts.
  const nbr = new Map<string, number[]>(); // key → per-projector representative distance, dilated
  for (const [key, [ix, iy, iz]] of coords) {
    const sum = new Array<number>(projectors.length).fill(0);
    const hits = new Array<number>(projectors.length).fill(0);
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const vm = voxels.get(`${ix + dx}_${iy + dy}_${iz + dz}`);
      if (!vm) continue;
      for (const [pi, e] of vm) { sum[pi] += e.dRep; hits[pi]++; }
    }
    nbr.set(key, sum.map((s, pi) => (hits[pi] ? s / hits[pi] : 0)));
  }

  // Alpha = this projector's representative distance / sum over projectors present nearby → Σα = 1.
  const out = grids.map((g) => new Float32Array(g.n));
  for (const [key, vm] of voxels) {
    const acc = nbr.get(key)!;
    let denom = 0; for (const d of acc) denom += d;
    if (denom <= 0) { const k = vm.size; for (const [pi, e] of vm) for (const c of e.cells) out[pi][c] = 1 / k; continue; }
    for (const [pi, e] of vm) { const a = acc[pi] / denom; for (const c of e.cells) out[pi][c] = a; }
  }

  // Black-lift weight: per voxel, overlap count = vm.size. A cell covered by this projector needs to
  // fake the black of the (maxOverlap − overlapHere) projectors that don't reach it, normalized so the
  // least-overlapped region = 1 and the deepest overlap = 0. Only meaningful with ≥2 projectors.
  // Counted over the SAME dilated neighbourhood as the alphas — a hard per-voxel count would say
  // "one projector here" at exactly the boundary cells the dilation exists to rescue, and then lift
  // the black floor to full inside an overlap that already has two projectors' worth of black.
  const overlapAt = (key: string): number => nbr.get(key)!.reduce((n, d) => (d > 0 ? n + 1 : n), 0);
  let maxOverlap = 1;
  for (const key of voxels.keys()) { const k = overlapAt(key); if (k > maxOverlap) maxOverlap = k; }
  const black = grids.map((g) => new Float32Array(g.n));
  if (maxOverlap > 1) {
    const span = maxOverlap - 1;
    for (const [key, vm] of voxels) {
      const wgt = (maxOverlap - overlapAt(key)) / span; // 0 at deepest overlap, 1 at single coverage
      for (const [pi, e] of vm) for (const c of e.cells) black[pi][c] = wgt;
    }
  }

  return grids.map((g, pi) => ({
    surfaceId: projectors[pi].surfaceId, w: g.mapW, h: g.mapH, data: out[pi],
    ...(maxOverlap > 1 ? { black: black[pi] } : {}),
  }));
}

// ── THE EXACT PATH, for a rig of CALIBRATED projectors ─────────────────────────────────────────────
//
// computeBlendMaps above has to discover which projectors light the same spot by bucketing world
// points into voxels, because a camera scan comes with no projector model to ask. That association is
// quantised — a voxel, then a 3x3x3 neighbourhood mean — and on the wall it shows: blocky patches in
// the ramp and ±8% of light across the overlap (measured on the multi-projector template's panorama,
// a 20x11 map). When every projector is CALIBRATED there is nothing to discover: each one's pose says
// exactly where a world point lands on its raster. So this path PROJECTS each traced point into every
// other projector, checks that projector really lights that spot (its own trace at that pixel hits the
// same point — not an occluder, not empty space), and weighs each by its CONTINUOUS distance to its
// own image frame in pixels. No voxels and no averaging: the partition of unity is exact at every
// sample, and the map has the trace's full resolution.

export interface ProjectedBlendInput {
  surfaceId: string;
  raster: [number, number];
  /** This projector's traced grid: w*h cells, world XYZ per cell (NaN where its ray missed the venue). */
  grid: { w: number; h: number; world: Float64Array };
  /** World point → this projector's raster pixel (its calibration), or null when behind the lens. */
  project: (p: [number, number, number]) => [number, number] | null;
}

// The same weight as frameWeight, continuous and in pixels: 0 exactly at the image edge.
const framePx = (u: number, v: number, w: number, h: number): number =>
  Math.max(0, Math.min(u, w - u)) * Math.max(0, Math.min(v, h - v));

// "Does projector j light world point p, and with what weight" — shared by the solve and by the
// overlap measure that sizes its grid (blendGridWidth), so the two can never disagree about where the
// overlap is.
function projectedWeights(projectors: ProjectedBlendInput[]) {
  const at = (g: ProjectedBlendInput['grid'], c: number): [number, number, number] | null => {
    const x = g.world[c * 3];
    return Number.isFinite(x) ? [x, g.world[c * 3 + 1], g.world[c * 3 + 2]] : null;
  };
  // How close a projector's own hit must be to a point to count as lighting it: a few cells of its
  // grid in world units (median neighbour spacing) — enough to absorb a pixel of reprojection and the
  // cell's own extent, far less than any occluder sitting in front of the surface.
  const tolerance = projectors.map(({ grid: g }) => {
    const d: number[] = [];
    for (let y = 0; y < g.h; y++) for (let x = 1; x < g.w; x++) {
      const a = at(g, y * g.w + x), b = at(g, y * g.w + x - 1);
      if (a && b) d.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    d.sort((p, q) => p - q);
    return 3 * (d.length ? d[d.length >> 1] : 0.05);
  });
  // Does projector j light world point p? Then its weight there; otherwise 0.
  const weightOf = (j: number, p: [number, number, number]): number => {
    const P = projectors[j], [W, H] = P.raster, g = P.grid;
    const px = P.project(p);
    if (!px || px[0] < 0 || px[1] < 0 || px[0] >= W || px[1] >= H) return 0;
    // Search the 3x3 cells around where p lands, not just the one. At the venue's silhouette the cell
    // under p can have its CENTRE ray just miss the surface while the projector plainly lights p — a
    // single-cell test then said "not lit", handed the other projector the whole share, and drew a
    // bright line along the screen's top and bottom edges right through the overlap (measured on the
    // multi-projector template). An occluder is still rejected: none of its cells are near p.
    const cx = Math.min(g.w - 1, Math.floor((px[0] / W) * g.w)), cy = Math.min(g.h - 1, Math.floor((px[1] / H) * g.h));
    let lit = false;
    for (let dy = -1; dy <= 1 && !lit; dy++) for (let dx = -1; dx <= 1 && !lit; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
      const q = at(g, y * g.w + x);
      if (q && Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) <= tolerance[j]) lit = true;
    }
    return lit ? framePx(px[0], px[1], W, H) : 0;
  };
  return { at, weightOf };
}

export function computeBlendMapsProjected(projectors: ProjectedBlendInput[]): BlendMap[] {
  if (!projectors.length) return [];
  const { at, weightOf } = projectedWeights(projectors);
  const counts = projectors.map(({ grid: g }) => new Uint8Array(g.w * g.h));
  const maps = projectors.map((P, i) => {
    const { w, h } = P.grid, [W, H] = P.raster;
    const data = new Float32Array(w * h);
    const hit = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = y * w + x, p = at(P.grid, c);
      if (!p) continue;
      const own = framePx(((x + 0.5) / w) * W, ((y + 0.5) / h) * H, W, H);
      let denom = own, n = 1;
      for (let j = 0; j < projectors.length; j++) {
        if (j === i) continue;
        const wj = weightOf(j, p);
        if (wj > 0) { denom += wj; n++; }
      }
      data[c] = denom > 0 ? own / denom : 1;
      hit[c] = 1;
      counts[i][c] = n;
    }
    // Carry each edge value one ring past the venue's silhouette. The map is sampled with linear
    // filtering, and a missed cell left at 0 would pull the outline's last pixels toward black — a
    // dark rim the blend did not mean. (Coverage at the silhouette is the bake's job, not this map's.)
    for (let pass = 0; pass < 2; pass++) {
      const src = data.slice(), had = hit.slice();
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const c = y * w + x;
        if (had[c]) continue;
        let s = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const cc = yy * w + xx;
          if (had[cc]) { s += src[cc]; k++; }
        }
        if (k) { data[c] = s / k; hit[c] = 1; }
      }
    }
    return { surfaceId: P.surfaceId, w, h, data } as BlendMap;
  });

  // Black-lift weight, as in computeBlendMaps: 1 where this projector is alone, 0 in the deepest overlap.
  let maxOverlap = 1;
  for (const cnt of counts) for (const n of cnt) if (n > maxOverlap) maxOverlap = n;
  if (maxOverlap > 1) {
    maps.forEach((m, i) => {
      const black = new Float32Array(m.w * m.h);
      for (let c = 0; c < black.length; c++) if (counts[i][c]) black[c] = (maxOverlap - counts[i][c]) / (maxOverlap - 1);
      m.black = black;
    });
  }
  return maps;
}

// ── HOW FINE THE EXACT PATH'S GRID HAS TO BE ───────────────────────────────────────────────────────
//
// The blend map is the fade's resolution, and the fade lives only across the OVERLAP. A fixed grid was
// fine on the multi-projector template (a 1.5 m overlap, ~45 cells at 160 wide) and wrong for the rigs
// that most need a blend: a 5% overlap gets 8 cells at 160 wide — steps of 12% of the light, visible as
// banding — and a 4K projector is no better off than a 720p one. So the grid is sized from the overlap
// it has to carry: at least BLEND_FADE_CELLS across the NARROWEST overlap in the rig, within a cell
// budget, because the map is stored per output in the project file.
//
// The width is measured on the same weights the solve uses (projectedWeights), at a cheap analysis
// grid, so the measure and the solve cannot disagree about where the overlap is.

/** Cells across the narrowest overlap; past ~32 the linear-filtered ramp has no visible step left. */
export const BLEND_FADE_CELLS = 32;
/** Per-output cell budget (~500x270 at 16:9). Saved as JSON per output, so it is bounded, not free. */
export const BLEND_MAX_CELLS = 131_072;
/** Never coarser than the previous fixed grid — a wide overlap gains nothing from fewer cells. */
export const BLEND_MIN_W = 160;

/**
 * The narrowest overlap in the rig, as a fraction of the projector image's WIDTH (0 = nothing
 * overlaps). Thickness is twice the deepest point of each overlap's distance transform: for a strip,
 * its width across; for a patch, its narrow dimension — the direction the fade has to cross.
 */
export function narrowestOverlap(projectors: ProjectedBlendInput[]): number {
  if (projectors.length < 2) return 0;
  const { at, weightOf } = projectedWeights(projectors);
  let best = 0;
  projectors.forEach((P, i) => {
    const { w, h } = P.grid;
    // Chamfer 3-4 distance to the nearest cell OUTSIDE the overlap (the grid's own edge counts as
    // outside: the fade has to reach 0 at the image frame).
    const INF = 1e9, d = new Float64Array(w * h);
    let any = false;
    for (let c = 0; c < w * h; c++) {
      const p = at(P.grid, c);
      let shared = false;
      if (p) for (let j = 0; j < projectors.length && !shared; j++) if (j !== i && weightOf(j, p) > 0) shared = true;
      d[c] = shared ? INF : 0;
      if (shared) any = true;
    }
    if (!any) return;
    const get = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : d[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = y * w + x;
      if (d[c]) d[c] = Math.min(d[c], get(x - 1, y) + 3, get(x, y - 1) + 3, get(x - 1, y - 1) + 4, get(x + 1, y - 1) + 4);
    }
    let deepest = 0;
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const c = y * w + x;
      if (d[c]) d[c] = Math.min(d[c], get(x + 1, y) + 3, get(x, y + 1) + 3, get(x + 1, y + 1) + 4, get(x - 1, y + 1) + 4);
      if (d[c] > deepest) deepest = d[c];
    }
    // deepest/3 cells from the overlap's middle to its edge; a cell-centred count of the full width.
    const frac = ((2 * deepest) / 3 - 1) / w;
    if (frac > 0 && (best === 0 || frac < best)) best = frac;
  });
  return best;
}

/** The exact path's grid width for a raster, from the narrowest overlap (narrowestOverlap). */
export function adaptiveBlendWidth(overlapFrac: number, raster: [number, number]): number {
  const [W, H] = raster;
  const byBudget = Math.floor(Math.sqrt((BLEND_MAX_CELLS * W) / H));
  const want = overlapFrac > 0 ? Math.ceil(BLEND_FADE_CELLS / overlapFrac) : BLEND_MIN_W;
  // Never finer than the projector itself, never coarser than the old fixed grid (unless the raster is).
  return Math.min(W, Math.max(BLEND_MIN_W, Math.min(want, byBudget)));
}
