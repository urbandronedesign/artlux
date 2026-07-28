// "Has this projector moved?" — answered in about five seconds instead of a full rescan.
//
// A Gray-code scan is ~42 planes plus a camera settle each, per projector: minutes, and it re-solves
// everything from scratch. A health check does not need that. It needs to know whether the picture
// still lands where the stored calibration says it does. So: project the calibration's own probe
// points as dots, look at where the camera sees them, compare against where they should appear.
//
// THE CAMERA IS NOT A REFERENCE. It is mounted but bumpable, so its pose is re-solved from the ArUco
// marker map immediately before this runs (see autoRecal) and used only within that session. Nothing
// persisted is in camera pixels — probes are projector pixels and world points, both of which survive
// the camera being knocked.
//
// This file is the IO half; every decision it feeds is computed in driftScore.ts, which imports
// nothing and is driven by scripts/test-recal.ts.

import type { ProjectorCalibration, CalibReference } from '../../../shared/protocol';
import * as slCapture from './slCapture';
import * as cam from './calibCapture';
import { DOT_RADIUS } from './graycode';
import { findBlobs, matchProbes, aggregate, groupProbes, type Matches, type DriftScore } from './driftScore';

export * from './driftScore';

export interface DriftCheckOptions {
  settleMs?: number;
  level?: number;      // dot brightness 0..255
  searchPx?: number;
}

// The live check. A scan session must already be active (slCapture.beginScan) and the camera open.
export async function runDriftCheck(
  reference: CalibReference,
  calibration: ProjectorCalibration,
  camPose: { camK: number[]; camDist: number[]; rotation: number[]; translation: [number, number, number] },
  opts: DriftCheckOptions = {},
): Promise<DriftScore | { error: string }> {
  const settleMs = opts.settleMs ?? 140;
  const level = opts.level ?? 255;
  const raster = calibration.imageSize;
  const { proj, world } = reference.probes;
  if (proj.length < 8) return { error: 'reference has too few probes' };

  // Black reference first: everything is measured as a CHANGE from the unlit room.
  await slCapture.projectDots([], 0);
  await new Promise((r) => setTimeout(r, settleMs));
  const blackFrame = await cam.grab();
  if (!blackFrame) return { error: 'no camera frame' };
  const { w: camW, h: camH } = blackFrame;

  const groups = groupProbes(proj, raster, 4, DOT_RADIUS);
  const parts: Matches[] = [];
  for (const g of groups) {
    const dots = g.map((i) => [proj[i * 2], proj[i * 2 + 1]] as [number, number]);
    await slCapture.projectDots(dots, level);
    await new Promise((r) => setTimeout(r, settleMs));
    const f = await cam.grab();
    if (!f) return { error: 'no camera frame mid-check' };
    if (f.w !== camW || f.h !== camH) return { error: 'camera frame size changed mid-check' };
    const blobs = findBlobs(f.data, blackFrame.data, camW, camH);
    // Matched WITHIN the frame: only probes lit here can claim a blob seen here.
    const gWorld: number[] = [];
    for (const i of g) gWorld.push(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
    parts.push(matchProbes({
      world: gWorld, blobs,
      camK: camPose.camK, camDist: camPose.camDist, camR: camPose.rotation, camT: camPose.translation,
      searchPx: opts.searchPx,
    }));
  }
  await slCapture.projectDots([], 0);
  return aggregate(parts);
}
