// Which outputs a rig blend is about, and whether a solved blend still describes them. Pure reads of
// the outputs list — the PLAYBACK side asks this (RigBlendStrip's "(stale)" label) and must not load
// blendController, the authoring-side solve, to ask it (suite plan Phase 1).

import type { ProjectorOutput } from '../../../shared/protocol';
import { getHost } from './calibHost';

/** The outputs a rig blend is about: enabled, and carrying a full calibration (pose actually solved). */
// The SDK types the outputs service generically (the host supplies the concrete type), so the cast
// here is the same one calibHost makes — not a papering-over.
export const allOutputs = (): ProjectorOutput[] => (getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[];

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

