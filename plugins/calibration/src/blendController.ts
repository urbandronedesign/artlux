// Solving the world-space blend for a RIG — the step that turns two independently calibrated
// projectors into one seamless picture.
//
// The maths (blendCompute) and the geometry (two Auto-Align runs against the same venue GLB, which
// are co-registered in one world frame by construction) both already existed. What did not exist was
// anything that put them together: the dense maps were discarded, so computeBlendMaps had no input
// and no caller. This module is that seam — capture, reload, solve, store, and the staleness rule.

import type { ProjectorBlend, ProjectorOutput } from '../../../shared/protocol';
import { computeBlendMaps, type ProjectorBlendInput } from './blendCompute';
import * as blendStore from './blendStore';
import * as calibNative from './calibNative';
import { getHost, storeBlend } from './calibHost';
import * as calibWorkspace from './calibWorkspace';
import { cameraPixelRayWorld } from './cvCamera';
import { raycastVenueBatch, hasVenueMeshes } from './venueRaycast';

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
const TRACE_GRID_W = 96;
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

/** The outputs a rig blend is about: enabled, and carrying a full calibration (pose actually solved). */
// The SDK types the outputs service generically (the host supplies the concrete type), so the cast
// here is the same one calibHost makes — not a papering-over.
const allOutputs = (): ProjectorOutput[] => (getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[];

export function rigOutputs(): ProjectorOutput[] {
  return allOutputs().filter((o) => o.enabled && o.calibration?.poseRms != null);
}

// A blend goes stale when the rig it describes is no longer the rig on stage: a member was
// recalibrated after the solve, or a projector joined or left. Stale still RENDERS — a slightly wrong
// seam beats a black hole in the middle of a show — but it must say so.
export function isStale(out: ProjectorOutput, rig: ProjectorOutput[] = rigOutputs()): boolean {
  const b = out.blend;
  if (!b) return false;
  const ids = rig.map((o) => o.surfaceId).sort();
  if (JSON.stringify(ids) !== JSON.stringify([...b.rigIds].sort())) return true;
  const solved = Date.parse(b.solvedAt);
  return rig.some((o) => {
    const t = o.calibration?.calibratedAt ? Date.parse(o.calibration.calibratedAt) : 0;
    return t > solved;
  });
}

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
      message: `no usable 3D map for ${missing.length} calibrated output(s) — load the venue model in the 3D scene (the map is traced from the calibration), or re-run Auto-Align on them`,
    };
  }

  const maps = computeBlendMaps(inputs);
  const rigIds = inputs.map((i) => i.surfaceId);
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
  return { ok: true, solved: rigIds, missing: [], message: `blend solved across ${rigIds.length} projectors` };
}

/** Drop the rig's blends — back to the analytic soft edge, without touching any calibration. */
export function clearRig(): void {
  for (const o of allOutputs()) if (o.blend) storeBlend(o.surfaceId, null);
}
