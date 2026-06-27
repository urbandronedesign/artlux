import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BoardDetectResult, CornerProjMap, ProjectorIntrinsicsResult, PnpResult,
} from '../../shared/protocol';

// Loads the native OpenCV calibration addon (native/calib/calib.node) in the main process — the
// sandboxed renderer can't require a .node, so it asks for CV solves over IPC. The addon links
// system OpenCV and needs LLVM/libclang at build time (the `opencv` crate uses bindgen), exactly
// like the gated NDI SDK, so it ships as a committed prebuilt (`npm run build:calib` on an OpenCV
// host). When it's missing every call returns null and the renderer surfaces "calibration addon
// unavailable" — the rest of the app runs untouched.
//
// Pipeline (hybrid, see docs): structured light recovers projector intrinsics + distortion
// (camera watches Gray-code on a checkerboard across poses → calibrateProjector); solvePnP then
// anchors the pose in the venue frame from operator-aimed crosshair ↔ model-pick correspondences.

interface CalibNative {
  /** findChessboardCornersSB + cornerSubPix on one grayscale/RGBA camera frame. */
  detectBoard(image: Buffer, w: number, h: number, cols: number, rows: number): BoardDetectResult;
  /**
   * Map detected camera-space board corners to projector pixels for one pose. `captures` is
   * `captureCount` grayscale planes (camW*camH each) concatenated — the Gray-code forward+inverse
   * sequence; `white`/`black` are the all-on/all-off reference frames for the shadow mask.
   */
  mapCornersToProjector(
    captures: Buffer, captureCount: number, camW: number, camH: number,
    projW: number, projH: number, corners: number[], white: Buffer, black: Buffer,
  ): CornerProjMap;
  /**
   * calibrateCamera over all poses → projector intrinsics + distortion. `objectPoints` (flat XYZ,
   * board frame) and `imagePoints` (flat projector px) are concatenated across poses; `pointCounts`
   * gives the corner count per pose.
   */
  calibrateProjector(
    objectPoints: number[], imagePoints: number[], pointCounts: number[],
    projW: number, projH: number,
  ): ProjectorIntrinsicsResult;
  /** solvePnP (intrinsics fixed) → projector pose in venue frame. */
  solvePnp(objectPts: number[], imagePts: number[], k: number[], dist: number[]): PnpResult;
}

const req = createRequire(__filename);

function loadNative(): CalibNative | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'calib.node'), // packaged (extraResources)
    join(process.cwd(), 'native/calib/calib.node'),
    join(__dirname, '../../native/calib/calib.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as CalibNative;
    } catch (e) {
      console.warn('[calib] native addon load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[calib] native OpenCV addon loaded' : '[calib] native OpenCV addon unavailable (calibration disabled)');

export function isAvailable(): boolean {
  return !!native;
}

export function detectBoard(image: Buffer, w: number, h: number, cols: number, rows: number): BoardDetectResult | null {
  if (!native) return null;
  try {
    return native.detectBoard(image, w, h, cols, rows);
  } catch (e) {
    console.warn('[calib] detectBoard failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function mapCorners(
  captures: Buffer, captureCount: number, camW: number, camH: number,
  projW: number, projH: number, corners: number[], white: Buffer, black: Buffer,
): CornerProjMap | null {
  if (!native) return null;
  try {
    return native.mapCornersToProjector(captures, captureCount, camW, camH, projW, projH, corners, white, black);
  } catch (e) {
    console.warn('[calib] mapCornersToProjector failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function calibrateProjector(
  objectPoints: number[], imagePoints: number[], pointCounts: number[],
  projW: number, projH: number,
): ProjectorIntrinsicsResult | null {
  if (!native) return null;
  try {
    return native.calibrateProjector(objectPoints, imagePoints, pointCounts, projW, projH);
  } catch (e) {
    console.warn('[calib] calibrateProjector failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function solvePnp(objectPts: number[], imagePts: number[], k: number[], dist: number[]): PnpResult | null {
  if (!native) return null;
  try {
    return native.solvePnp(objectPts, imagePts, k, dist);
  } catch (e) {
    console.warn('[calib] solvePnp failed:', (e as Error)?.message ?? e);
    return null;
  }
}
