// Markerless per-projector geometry (Phase 0). No printed board: the loaded venue model is the metric
// reference. Flow per projector:
//   1. solveCameraPose  — a few camera-image↔model picks → RANSAC solvePnP → camera pose in venue frame.
//   2. solveGeometry    — scan Gray-code onto the venue → dense camera↔projector decode → raycast each
//      camera pixel onto the venue mesh (3D point) → pair with its projector pixel → resection the
//      projector (guided intrinsics + RANSAC pose) → ProjectorCalibration + a dense per-pixel 3D map
//      (VIOSO-style: projector pixel ↔ world XYZ, kept for world-space blend + MPCDI export).
//
// Camera intrinsics are supplied (stored/nominal profile) for the MVP; board-free self-calibration
// from the scan is a later increment. "3D mapping doesn't have to be perfect" (VIOSO) — RANSAC + a
// generous decode/raycast filter carry the robustness.

import type { ProjectorCalibration, ArucoDetection, MarkerMap } from '../../../shared/protocol';
import { cameraPixelRayWorld } from './cvCamera';
import { raycastVenueBatch, hasVenueMeshes } from './venueRaycast';
import { captureGrayCode } from './slCapture';
import { applyCamMask, type CamMask } from './camMask';
import * as calibNative from './calibNative';

export interface MarkerlessConfig {
  cameraK: number[];     // camera intrinsics, row-major 3×3 (stored/nominal profile)
  cameraDist: number[];  // camera distortion [k1,k2,p1,p2,k3]
  stride: number;        // dense-decode subsample in camera px (4 → thousands of points)
  settleMs: number;      // camera-exposure settle after each projected plane
  camMask?: CamMask;     // optional exclusion polygons (reflective hotspots / obstructions) in camera px
}

export const defaultMarkerlessConfig = (): MarkerlessConfig => ({ cameraK: [], cameraDist: [0, 0, 0, 0, 0], stride: 4, settleMs: 120 });

// One camera-pose correspondence: a clicked camera-image pixel ↔ the matching venue-model world point.
export interface CamPick { camPx: [number, number]; world: [number, number, number] }

export interface CameraPose { rotation: number[]; translation: [number, number, number]; rms: number }

// One-click recalibration: turn an ArUco detection + the venue's registered marker map into the same
// CamPick[] the manual Anchor step produces — each detected marker contributes its 4 sub-pixel corners
// paired with the marker's known 3D corners. For markers registered by centre only (no per-corner 3D),
// all 4 image corners pair with the single 3D point (their mean image point ≈ the centre). 4 corners
// per marker means even one marker meets the ≥4 minimum; RANSAC in solveCameraPose rejects outliers.
export function camPicksFromAruco(det: ArucoDetection, map: MarkerMap): CamPick[] {
  const byId = new Map(map.markers.map((m) => [m.id, m.world]));
  const picks: CamPick[] = [];
  for (let i = 0; i < det.ids.length; i++) {
    const world = byId.get(det.ids[i]);
    if (!world) continue;
    const base = i * 8;
    for (let c = 0; c < 4; c++) {
      picks.push({ camPx: [det.corners[base + c * 2], det.corners[base + c * 2 + 1]], world });
    }
  }
  return picks;
}

// Recover the camera's pose in the venue frame from ≥4 camera-image↔model picks (intrinsics fixed).
export async function solveCameraPose(picks: CamPick[], cameraK: number[], cameraDist: number[]): Promise<CameraPose | { error: string }> {
  if (picks.length < 4) return { error: 'need ≥4 camera↔model picks' };
  if (cameraK.length !== 9) return { error: 'camera intrinsics not set' };
  const api = calibNative;
  if (!api?.calibSolvePnpRansac) return { error: 'calibration addon unavailable' };
  const obj: number[] = [], img: number[] = [];
  for (const p of picks) { obj.push(p.world[0], p.world[1], p.world[2]); img.push(p.camPx[0], p.camPx[1]); }
  const r = await api.calibSolvePnpRansac(obj, img, cameraK, cameraDist, 3.0);
  if (!r) return { error: 'camera PnP failed' };
  return { rotation: r.rotation, translation: r.translation as [number, number, number], rms: r.rms };
}

export interface MarkerlessResult {
  calibration: ProjectorCalibration;
  decoded: number; // dense correspondences decoded
  hits: number;    // of those, how many rays hit the venue mesh
  cameraK: number[]; // the camera intrinsics actually used (self-cal or nominal)
  selfCal: { ok: boolean; rms: number; inliers: number } | null; // null when not attempted
  cameraPoseRms: number; // camera-pose RMS with the chosen intrinsics (projector RMS is in calibration)
  // Dense per-pixel 3D map (VIOSO-style): flat projector-pixel pairs + aligned world-XYZ triples.
  denseMap: { proj: number[]; world: number[] };
}

// Scan the venue, decode dense correspondences, (optionally) self-calibrate the camera from the scan,
// solve the camera pose from the picks with those intrinsics, raycast to 3D, and resection the
// projector. A scan must already be active (slCapture.beginScan) and the camera open (calibCapture).
// cfg.cameraK is the nominal/fallback profile; when `selfCal` and the gates pass it's replaced by the
// focal-from-fundamental-matrix estimate.
export async function solveGeometry(cfg: MarkerlessConfig, picks: CamPick[], selfCal: boolean): Promise<MarkerlessResult | { error: string }> {
  const api = calibNative;
  if (!api?.calibDecodeDense || !api?.calibCalibrateGuided || !api?.calibSolvePnpRansac) return { error: 'calibration addon unavailable' };
  if (!hasVenueMeshes()) return { error: 'no venue model loaded' };
  if (picks.length < 4) return { error: 'need ≥4 camera↔model picks (Anchor step)' };

  // 1. Capture Gray-code on the venue.
  const scan = await captureGrayCode(cfg.settleMs);
  if ('error' in scan) return { error: scan.error };
  const { camW, camH, planeCount, captures, white, black, projW, projH } = scan;

  // Drop masked camera pixels (reflective hotspots / obstructions) before decode by zeroing their
  // white/black refs — the decode's contrast gate then rejects them (see camMask.ts).
  if (cfg.camMask) applyCamMask(white, black, camW, camH, cfg.camMask);

  // 2. Dense decode → camera↔projector correspondences.
  const dense = await api.calibDecodeDense(
    captures.buffer as ArrayBuffer, planeCount, camW, camH, projW, projH,
    white.buffer as ArrayBuffer, black.buffer as ArrayBuffer, Math.max(1, cfg.stride),
  );
  if (!dense) return { error: 'dense decode failed (addon unavailable)' };
  const N = dense.camX.length;
  if (N < 50) return { error: `only ${N} decoded points — darken the room / improve focus` };

  // 3. Camera intrinsics: self-calibrate from the scan (gated), else the nominal profile.
  let cameraK = cfg.cameraK;
  let selfCalInfo: { ok: boolean; rms: number; inliers: number } | null = null;
  if (selfCal && api.calibSelfCalibrate) {
    const sc = await api.calibSelfCalibrate(dense.camX, dense.camY, dense.projX, dense.projY, camW, camH, projW, projH);
    if (sc) { selfCalInfo = { ok: sc.ok, rms: sc.rms, inliers: sc.inliers }; if (sc.ok && sc.camK.length === 9) cameraK = sc.camK; }
  }
  if (cameraK.length !== 9) return { error: 'camera intrinsics unavailable (set FOV or enable self-cal)' };

  // 4. Camera pose with the chosen intrinsics.
  const cp = await solveCameraPose(picks, cameraK, cfg.cameraDist);
  if ('error' in cp) return { error: `camera pose: ${cp.error}` };
  const cameraR = cp.rotation, cameraT = cp.translation;

  // 5. Raycast each camera pixel onto the venue mesh → 3D point.
  const rays = new Array<{ origin: [number, number, number]; dir: [number, number, number] }>(N);
  for (let i = 0; i < N; i++) {
    rays[i] = cameraPixelRayWorld(cameraK, cfg.cameraDist, cameraR, cameraT, dense.camX[i], dense.camY[i]);
  }
  const hits = raycastVenueBatch(rays);

  // 4. Pair venue 3D ↔ projector pixel (drop ray misses).
  const objectPoints: number[] = [], imagePoints: number[] = [];
  let used = 0;
  for (let i = 0; i < N; i++) {
    const h = hits[i];
    if (!h) continue;
    objectPoints.push(h[0], h[1], h[2]);
    imagePoints.push(dense.projX[i], dense.projY[i]);
    used++;
  }
  if (used < 30) return { error: `only ${used} rays hit the venue — check camera pose / model alignment` };

  // 6. Resection the projector: guided intrinsics (seed from throw ratio, fix principal point for the
  //    single-view solve), then RANSAC pose against the same 3D↔2D set.
  const intr = await api.calibCalibrateGuided(objectPoints, imagePoints, [used], projW, projH, [], true, false);
  if (!intr) return { error: 'projector resection failed' };
  const pose = await api.calibSolvePnpRansac(objectPoints, imagePoints, intr.k, intr.dist, 2.0);
  if (!pose) return { error: 'projector pose solve failed' };

  const calibration: ProjectorCalibration = {
    intrinsics: intr.k,
    distortion: intr.dist,
    rotation: pose.rotation,
    translation: pose.translation,
    imageSize: [projW, projH],
    intrinsicsRms: intr.rms,
    poseRms: pose.rms,
    calibratedAt: new Date().toISOString(),
  };
  return { calibration, decoded: N, hits: used, cameraK, selfCal: selfCalInfo, cameraPoseRms: cp.rms, denseMap: { proj: imagePoints, world: objectPoints } };
}
