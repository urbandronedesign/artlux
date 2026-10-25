// THE TEST SOURCE ON THE RIG — the UV checker in place of the show's content, and the way back.
//
// ArtLux Calibrator judges a calibration on the wall against a known image, so it OPENS every project
// with the UV checker on every surface the rig puts on the wall (owner, 2026-10-25), and its Test &
// sign-off step switches between that and the show. The show's own content is kept in the project
// (calibRig.testBackup) while the checker plays — persisted, because a Calibrator save made with the
// checker up must never cost the show its content.
//
// THE WAY BACK IS ON THE SHOW'S SIDE, AND IT IS UNCONDITIONAL. Every route out of the Calibrator — the
// sign-off's hand-off button, File ▸ Open in ArtLux Show…, a plain save and quit, a recalibration hand-
// back — ends with ArtLux Show OPENING the file, so `withShowContent` on that open is the one place that
// cannot be skipped. Before it existed, only the sign-off button restored, and a show opened after any
// other route played the grid.
//
// Both are PURE transforms of the opened document, applied inside applyProjectData: the result IS what
// was opened, so the saved-document baseline settles on it — the Calibrator does not mark a project it
// merely opened as changed, and quitting without a save leaves the file exactly as it was.

import { modelBindings, type ProjectorOutput, type Scene3D } from '../../../shared/protocol';
import type { Surface } from '../types';

export type UvSize = 'fhd' | '4k';

/** The content that puts the UV checker on a surface. Its code is generated afterwards by
 *  services/uvCheckerSync.ts, which knows the surface's name and the screens bound to it. */
export const uvCheckerContent = (size: UvSize) =>
  ({ type: 'SHADER', shaderId: 'uv-checker', uvChecker: { size }, shaderRes: size === '4k' ? 2160 : 1080, opacity: 1 });

/** The surfaces the rig actually puts on the wall: every one a venue mesh or screen shows, plus the own
 *  surface of an output that is not rendering the venue (a flat, uncalibrated projector). */
export function testTargets(scene: Partial<Pick<Scene3D, 'models'>>, outputs: ProjectorOutput[]): string[] {
  const ids = new Set<string>();
  for (const m of scene.models ?? []) for (const b of modelBindings(m)) if (b.surfaceId) ids.add(b.surfaceId);
  for (const o of outputs) if (o.enabled && !(o.useCalibration && o.calibration?.poseRms != null)) ids.add(o.surfaceId);
  return [...ids];
}

// The opened document, loosely: applyProjectData takes `any`, and so do these, returning a copy.
type Doc = { surfaces?: Surface[]; scene3D?: Partial<Scene3D>; projectorOutputs?: ProjectorOutput[] } & Record<string, unknown>;

/** ArtLux Calibrator's open: the UV checker on every surface the rig lights, the show's content kept.
 *  A file saved with a test source already on is left as it is — its backup already holds the show. */
export function withTestSource(data: Doc, size: UvSize = 'fhd'): Doc {
  if (!data || !Array.isArray(data.surfaces) || data.scene3D?.calibRig?.testBackup) return data;
  const targets = new Set(testTargets(data.scene3D ?? {}, Array.isArray(data.projectorOutputs) ? data.projectorOutputs : []));
  const hit = data.surfaces.filter((s) => targets.has(s.id) && s.content);
  if (!hit.length) return data;
  const backup = Object.fromEntries(hit.map((s) => [s.id, s.content]));
  return {
    ...data,
    surfaces: data.surfaces.map((s) => (s.id in backup ? { ...s, content: uvCheckerContent(size) as unknown as Surface['content'] } : s)),
    scene3D: { ...data.scene3D, calibRig: { ...data.scene3D?.calibRig, testBackup: backup } },
  };
}

/** Every other build's open: the show's own content back on every surface the test source replaced. */
export function withShowContent(data: Doc): Doc {
  const backup = data?.scene3D?.calibRig?.testBackup;
  if (!backup || !Array.isArray(data.surfaces)) return data;
  const { testBackup: _dropped, ...rig } = data.scene3D!.calibRig!;
  return {
    ...data,
    surfaces: data.surfaces.map((s) => (s.id in backup && backup[s.id] ? { ...s, content: backup[s.id] as Surface['content'] } : s)),
    scene3D: { ...data.scene3D, calibRig: rig },
  };
}
