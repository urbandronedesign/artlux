// Solving the world-space blend for a RIG — the step that turns two independently calibrated
// projectors into one seamless picture.
//
// The maths (blendCompute) and the geometry (two Auto-Align runs against the same venue GLB, which
// are co-registered in one world frame by construction) both already existed. What did not exist was
// anything that put them together: the dense maps were discarded, so computeBlendMaps had no input
// and no caller. This module is that seam — capture, reload, solve, store, and the staleness rule.

import type { ProjectorBlend, ProjectorOutput } from '../../../shared/protocol';
import {
  computeBlendMaps, computeBlendMapsProjected, narrowestOverlap, adaptiveBlendWidth, coverageSums,
  type BlendMap, type ProjectorBlendInput, type ProjectedBlendInput,
} from './blendCompute';
import * as blendStore from './blendStore';
import { rigOutputs, allOutputs } from './blendStale';
import * as calibNative from './calibNative';
import { getHost, storeBlend } from './calibHost';
import * as calibWorkspace from './calibWorkspace';
import { cameraPixelRayWorld, reproject } from './cvCamera';
import { raycastVenueBatch, hasVenueMeshes } from './venueRaycast';
import { projectorViewProj } from './mpcdiData';
import { bakeWorld, type WorldMap } from '@/components/Simulator3D/projectorBake'; // host module — the GPU bake

export interface SolveReport {
  ok: boolean;
  /** Outputs that received a new blend. */
  solved: string[];
  /** Calibrated outputs we had no dense map for — they are the reason a blend can be incomplete. */
  missing: string[];
  message: string;
}

/** Keep alpha readable in the .artlux and roughly a third of the bytes; 1e-4 is far below visible. */
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

// A dense map describes ONE venue's geometry. Opening a different project must not leave the previous
// room's scans in the store, where they would silently be blended against geometry that is not there
// — and there is no project-change event to subscribe to, so every entry point checks.
let lastProject: string | null | undefined;
function projectFile(): string | null {
  const p = getHost()?.project.path() ?? null;
  if (lastProject !== undefined && p !== lastProject) blendStore.clear();
  lastProject = p;
  return p;
}

// Persist a scan: session store + a sidecar beside the project so a later rig solve can use it after
// a restart. Called from the wizard the moment a scan succeeds — see AutoAlignWizard.runScan.
export async function captureScan(
  surfaceId: string,
  raster: [number, number],
  denseMap: { proj: number[]; world: number[] },
): Promise<void> {
  // Resolve the project FIRST: projectFile() is what notices a document change and clears the store,
  // and doing it after the put would drop the scan we just took.
  const project = projectFile();
  const capturedAt = new Date().toISOString();
  blendStore.put(surfaceId, { raster, denseMap, capturedAt });
  if (!project) return; // unsaved project — the session store still lets a rig solve happen now
  await calibNative.calibArtifactWrite(project, {
    version: 1, surfaceId, raster, capturedAt, proj: denseMap.proj, world: denseMap.world,
  });
}

// Pull a projector's map back off disk into the session store (a rig solved across sessions).
export async function loadScan(surfaceId: string): Promise<boolean> {
  const project = projectFile();     // before the has() check — it may invalidate the whole store
  if (blendStore.has(surfaceId)) return true;
  if (!project) return false;
  const f = await calibNative.calibArtifactRead(project, surfaceId);
  if (!f) return false;
  blendStore.put(surfaceId, {
    raster: f.raster, denseMap: { proj: f.proj, world: f.world }, capturedAt: f.capturedAt, fromDisk: true,
  });
  return true;
}

// A dense map WITHOUT a camera: trace it from the solved calibration by raycasting a grid of
// projector pixels into the venue mesh — the same regeneration the MPCDI exporter uses
// (regionFromCalibration). This is what lets manually- and board-calibrated projectors, which have
// no Auto-Align scan, join a rig blend. Session-only, never written as an artifact: it derives FROM
// the calibration, so persisting it would cache something regenerable — and a recalibrated output
// must not blend against its old trace (solveRig re-traces when the calibration is newer).
// 160 rays across, not 96: computeBlendMaps sizes its grid to ~8 samples per cell, so the trace density
// IS the blend's resolution — 96 gave a 20x11 map whose half-cell association error left the overlap
// within ±8% of even light (measured on the multi-projector template); finer halves it. It is one pass
// at solve time (~16k rays per projector), never per frame.
const TRACE_GRID_W = 160;
function traceScan(o: ProjectorOutput): boolean {
  const cal = o.calibration;
  if (!cal || cal.poseRms == null || !hasVenueMeshes()) return false;
  const [pw, ph] = cal.imageSize;
  if (!pw || !ph) return false;
  projectFile(); // notice a project switch BEFORE the put, or the put would be wiped by the clear
  const gw = TRACE_GRID_W, gh = Math.max(2, Math.round((gw * ph) / pw));
  const dist = cal.distortion ?? [0, 0, 0, 0, 0];
  const t = cal.translation as [number, number, number];
  const rays = new Array<{ origin: [number, number, number]; dir: [number, number, number] }>(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    rays[y * gw + x] = cameraPixelRayWorld(cal.intrinsics, dist, cal.rotation, t, ((x + 0.5) / gw) * pw, ((y + 0.5) / gh) * ph);
  }
  const hits = raycastVenueBatch(rays);
  const proj: number[] = [], world: number[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!h) continue;
    const x = i % gw, y = (i / gw) | 0;
    proj.push(((x + 0.5) / gw) * pw, ((y + 0.5) / gh) * ph);
    world.push(h[0], h[1], h[2]);
  }
  if (proj.length < 60) return false; // the frustum barely touches the venue — nothing to blend with
  blendStore.put(o.surfaceId, {
    raster: [pw, ph], denseMap: { proj, world }, capturedAt: new Date().toISOString(), synthetic: true,
  });
  return true;
}

// A traced map back on its grid, with the projector's own projection — the exact blend's input. The
// trace stores hits only, but it was cast on a known TRACE_GRID_W grid at cell centres, so each hit's
// pixel names its cell exactly.
function projectedInput(o: ProjectorOutput): ProjectedBlendInput {
  const cal = o.calibration!, s = blendStore.get(o.surfaceId)!;
  const [pw, ph] = s.raster, gw = TRACE_GRID_W, gh = Math.max(2, Math.round((gw * ph) / pw));
  const world = new Float64Array(gw * gh * 3).fill(Number.NaN);
  const P = s.denseMap.proj, Wd = s.denseMap.world;
  for (let i = 0; i < P.length / 2; i++) {
    const x = Math.min(gw - 1, Math.floor((P[i * 2] / pw) * gw)), y = Math.min(gh - 1, Math.floor((P[i * 2 + 1] / ph) * gh));
    const c = (y * gw + x) * 3;
    world[c] = Wd[i * 3]; world[c + 1] = Wd[i * 3 + 1]; world[c + 2] = Wd[i * 3 + 2];
  }
  const dist = cal.distortion ?? [0, 0, 0, 0, 0], t = cal.translation as [number, number, number];
  return {
    surfaceId: o.surfaceId, raster: [pw, ph], grid: { w: gw, h: gh, world },
    project: (p) => reproject(cal.intrinsics, dist, cal.rotation, t, p),
  };
}

// ── THE GPU PATH: every member calibrated, none camera-scanned ───────────────────────────────────
//
// The CPU trace above is three's Raycaster with no BVH — O(rays x triangles) — which is why it is held
// to a 160-wide grid, and that grid WAS the blend's resolution. Here one depth-tested render per
// projector (projectorBake.bakeWorld, over the same caster set the calibration file is baked from)
// gives the world point under every pixel, so the grid can be whatever the overlap needs: measured on
// a cheap analysis grid, then solved at adaptiveBlendWidth.
const ANALYSIS_W = 256;
const WORLD_BAKE_W = 1024;

/**
 * A projector's world map resampled onto a gw-wide grid of PHYSICAL pixel centres. The bake renders
 * the ideal pinhole (no lens distortion, like ProjectorScene's own render), while the blend is indexed by
 * the physical panel pixel (ProjectorScene's blend runs on gl_FragCoord, after the distortion pass) —
 * so with a distorted lens each cell first finds the ideal pixel its physical ray goes through.
 */
function gridFromWorldMap(o: ProjectorOutput, map: WorldMap, gw: number, ghIn?: number): ProjectedBlendInput {
  const cal = o.calibration!, [pw, ph] = cal.imageSize;
  const gh = ghIn ?? Math.max(2, Math.round((gw * ph) / pw));
  const dist = cal.distortion ?? [0, 0, 0, 0, 0], t = cal.translation as [number, number, number];
  const distorted = dist.some((v) => v !== 0), ideal = [0, 0, 0, 0, 0];
  const world = new Float64Array(gw * gh * 3).fill(Number.NaN);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let u = ((x + 0.5) / gw) * pw, v = ((y + 0.5) / gh) * ph;
    if (distorted) {
      const r = cameraPixelRayWorld(cal.intrinsics, dist, cal.rotation, t, u, v);
      const q = reproject(cal.intrinsics, ideal, cal.rotation, t,
        [r.origin[0] + r.dir[0], r.origin[1] + r.dir[1], r.origin[2] + r.dir[2]]);
      if (!q) continue;
      [u, v] = q;
    }
    const mx = Math.floor((u / pw) * map.w), my = Math.floor((v / ph) * map.h);
    if (mx < 0 || my < 0 || mx >= map.w || my >= map.h) continue;
    const s = (my * map.w + mx) * 3, c = (y * gw + x) * 3;
    world[c] = map.world[s]; world[c + 1] = map.world[s + 1]; world[c + 2] = map.world[s + 2];
  }
  return {
    surfaceId: o.surfaceId, raster: [pw, ph], grid: { w: gw, h: gh, world },
    project: (p) => reproject(cal.intrinsics, dist, cal.rotation, t, p),
  };
}

/**
 * Bake every member and solve at the adaptive resolution. Null when nothing could be baked (the 3D
 * view has not been opened this session, so no venue is registered) — the caller then falls back to the CPU trace, which
 * still gives a correct, coarser blend. A bake that hits too little of the venue is NOT a fallback
 * case: it is reported, as the trace would.
 */
/** One projector's world map — null when nothing can be baked, 'miss' when it hits ~nothing. */
function bakeOutput(o: ProjectorOutput): WorldMap | null | 'miss' {
  const cal = o.calibration!, [pw, ph] = cal.imageSize;
  const vp = pw && ph ? projectorViewProj(cal) : null;
  if (!vp) return 'miss';
  // At most WORLD_BAKE_W wide: the map is only ever sampled at blend-cell centres, and the blend's
  // own budget keeps it under ~500 cells across — a 4K render would buy nothing but memory.
  const bw = Math.min(pw, WORLD_BAKE_W), bh = Math.max(2, Math.round((bw * ph) / pw));
  const map = bakeWorld(vp, bw, bh);
  if (!map) return null;                         // nothing to bake against — not this projector's fault
  return map.hits < 60 ? 'miss' : map;
}

function solveOnGpu(rig: ProjectorOutput[]): { maps: BlendMap[]; missing: string[] } | null {
  const baked: Array<{ o: ProjectorOutput; map: WorldMap }> = [];
  const missing: string[] = [];
  for (const o of rig) {
    const map = bakeOutput(o);
    if (map === null) return null;
    if (map === 'miss') { missing.push(o.surfaceId); continue; }
    baked.push({ o, map });
  }
  if (missing.length) return { maps: [], missing };
  const frac = narrowestOverlap(baked.map(({ o, map }) => gridFromWorldMap(o, map, Math.min(ANALYSIS_W, map.w))));
  const inputs = baked.map(({ o, map }) => gridFromWorldMap(o, map, adaptiveBlendWidth(frac, o.calibration!.imageSize)));
  return { maps: computeBlendMapsProjected(inputs), missing: [] };
}

export interface BlendCoverage {
  surfaceId: string;
  w: number;
  h: number;
  /** Σα arriving at the point each cell of this projector's blend lights; NaN where it lights nothing. */
  sums: Float32Array;
}

/**
 * The blend inspector's sum, taken THROUGH THE VENUE (blendCompute.coverageSums) for every calibrated
 * output carrying a blend. Null when the venue is not registered (the 3D view has not been opened),
 * because without the geometry there is no honest way to say which cells light the same spot.
 */
export function blendCoverage(): BlendCoverage[] | null {
  const outs = rigOutputs().filter((o) => o.blend);
  if (!outs.length) return [];
  const inputs: ProjectedBlendInput[] = [];
  for (const o of outs) {
    const map = bakeOutput(o);
    if (map === null) return null;
    if (map === 'miss') return null;
    inputs.push(gridFromWorldMap(o, map, o.blend!.w, o.blend!.h));
  }
  const sums = coverageSums(inputs, outs.map((o) => ({ w: o.blend!.w, h: o.blend!.h, data: o.blend!.alpha })));
  return outs.map((o, i) => ({ surfaceId: o.surfaceId, w: o.blend!.w, h: o.blend!.h, sums: sums[i] }));
}

// rigOutputs / allOutputs / isStale live in ./blendStale — the PLAYBACK side reads the staleness rule
// (RigBlendStrip's "(stale)" label) without loading this module, which is authoring (suite plan Phase 1).
export { rigOutputs, isStale } from './blendStale';

// Solve the blend across every calibrated output and write it to each.
//
// Deliberately refuses rather than half-solving: a rig blend computed from a subset would hand the
// missing projector's share to whoever IS in the solve, which on the wall is a bright band exactly
// where the absent projector overlaps. Better to say which map is missing.
export async function solveRig(): Promise<SolveReport> {
  // slCapture and the camera are module singletons — a solve during a scan would fight it.
  if (calibWorkspace.getState().target !== null) {
    return { ok: false, solved: [], missing: [], message: 'a calibration session is open — close the wizard first' };
  }
  const rig = rigOutputs();
  if (rig.length < 2) {
    return { ok: false, solved: [], missing: [], message: `${rig.length} calibrated output(s) — a blend needs at least two` };
  }

  // No camera scan anywhere in the rig → every member's geometry derives from its pose, so the exact
  // path applies and the GPU can trace it at full resolution. A camera SCAN keeps the voxel path
  // below — its geometry is measured, not derived from a pose.
  let scanned = false;
  for (const o of rig) if ((await loadScan(o.surfaceId)) && !blendStore.get(o.surfaceId)?.synthetic) scanned = true;
  if (!scanned) {
    const gpu = solveOnGpu(rig);
    if (gpu?.missing.length) {
      return {
        ok: false, solved: [], missing: gpu.missing,
        message: `no usable 3D map for ${gpu.missing.length} calibrated output(s) — rendered from the calibration, it hit too little of the venue model; check the calibration`,
      };
    }
    if (gpu) return storeMaps(gpu.maps, 'exact');
    console.warn('[blend] GPU world bake unavailable — tracing on the CPU at a fixed grid');
  }

  const inputs: ProjectorBlendInput[] = [];
  const missing: string[] = [];
  for (const o of rig) {
    let ok = await loadScan(o.surfaceId);
    // A traced map derives from the calibration — a recalibrated output must not blend against its
    // old trace, so re-trace when the calibration is newer than the map. (A camera SCAN measures the
    // geometry independently of the projector calibration, so it stays valid across a re-solve.)
    const prior = ok ? blendStore.get(o.surfaceId) : undefined;
    if (prior?.synthetic && o.calibration?.calibratedAt
      && Date.parse(o.calibration.calibratedAt) > Date.parse(prior.capturedAt)) ok = false;
    if (!ok) ok = traceScan(o);
    if (!ok) { missing.push(o.surfaceId); continue; }
    const s = blendStore.get(o.surfaceId)!;
    if (s.denseMap.proj.length < 60) { missing.push(o.surfaceId); continue; } // a scan that decoded ~nothing
    inputs.push({ surfaceId: o.surfaceId, raster: s.raster, denseMap: s.denseMap });
  }
  if (missing.length) {
    return {
      ok: false, solved: [], missing,
      // Two different situations, and the old single message only described one. With NO venue meshes
      // registered, the model is usually in the project but the 3D view has not been opened this
      // session — it is the view that loads the model the trace casts into — and telling that operator
      // to "load the venue model" sent them looking for a model that was already there.
      message: hasVenueMeshes()
        ? `no usable 3D map for ${missing.length} calibrated output(s) — the traced coverage hit too little of the venue model; check the calibration, or re-run Auto-Align on them`
        : `no usable 3D map for ${missing.length} calibrated output(s) — open the 3D view once (it loads the venue model the blend is traced against), then solve again`,
    };
  }

  // Every member traced from its calibration → the EXACT path (computeBlendMapsProjected): each
  // projector's pose says where a point lands on the others, so nothing has to be associated by voxel.
  // A camera SCAN in the rig keeps the voxel path — its geometry is measured, not derived from a pose.
  const traced = rig.every((o) => blendStore.get(o.surfaceId)?.synthetic && o.calibration);
  const maps = traced ? computeBlendMapsProjected(rig.map((o) => projectedInput(o))) : computeBlendMaps(inputs);
  return storeMaps(maps, traced ? 'exact, CPU trace' : 'scanned');
}

function storeMaps(maps: BlendMap[], how: string): SolveReport {
  const rigIds = maps.map((m) => m.surfaceId);
  const solvedAt = new Date().toISOString();
  for (const m of maps) {
    const blend: ProjectorBlend = {
      w: m.w, h: m.h,
      alpha: Array.from(m.data, round4),
      ...(m.black ? { black: Array.from(m.black, round4) } : {}),
      solvedAt, rigIds,
    };
    storeBlend(m.surfaceId, blend);
  }
  // The map size is in the message because it is the blend's resolution — the number to look at when
  // an overlap shows steps.
  const size = maps.map((m) => `${m.w}×${m.h}`).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  return { ok: true, solved: rigIds, missing: [], message: `blend solved across ${rigIds.length} projectors (${how}, ${size} map)` };
}

/** Drop the rig's blends — back to the analytic soft edge, without touching any calibration. */
export function clearRig(): void {
  for (const o of allOutputs()) if (o.blend) storeBlend(o.surfaceId, null);
}
