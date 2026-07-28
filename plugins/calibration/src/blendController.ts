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
    if (!(await loadScan(o.surfaceId))) { missing.push(o.surfaceId); continue; }
    const s = blendStore.get(o.surfaceId)!;
    if (s.denseMap.proj.length < 60) { missing.push(o.surfaceId); continue; } // a scan that decoded ~nothing
    inputs.push({ surfaceId: o.surfaceId, raster: s.raster, denseMap: s.denseMap });
  }
  if (missing.length) {
    return {
      ok: false, solved: [], missing,
      message: `no usable scan for ${missing.length} calibrated output(s) — re-run Auto-Align on them, then solve`,
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
