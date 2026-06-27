import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BoardDetectResult, CornerProjMap, ProjectorIntrinsicsResult, PnpResult, CameraFrame, DenseMap,
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
  /** Dense camera→projector decode (markerless correspondences), subsampled by `stride`. */
  decodeDenseMap(captures: Buffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, white: Buffer, black: Buffer, stride: number): DenseMap;
  /** RANSAC solvePnP (robust pose). */
  solvePnpRansac(objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number): PnpResult;
  /** Guided projector resection (intrinsic guess + degeneracy flags). */
  calibrateProjectorGuided(objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean): ProjectorIntrinsicsResult;
  /** Open a camera by index via OpenCV's DirectShow backend (for cameras getUserMedia can't drive). */
  cameraOpen(index: number, width: number, height: number, fps: number, fourcc: string): boolean;
  /** Grab one grayscale frame (Buffer of w*h bytes) from the open camera, or null if none ready. */
  cameraGrabGray(): { w: number; h: number; data: Buffer } | null;
  /** Release the open camera. */
  cameraClose(): void;
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

export function decodeDense(
  captures: Buffer, captureCount: number, camW: number, camH: number,
  projW: number, projH: number, white: Buffer, black: Buffer, stride: number,
): DenseMap | null {
  if (!native) return null;
  try {
    return native.decodeDenseMap(captures, captureCount, camW, camH, projW, projH, white, black, stride);
  } catch (e) {
    console.warn('[calib] decodeDenseMap failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function solvePnpRansac(objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number): PnpResult | null {
  if (!native) return null;
  try {
    return native.solvePnpRansac(objectPts, imagePts, k, dist, reprojErr);
  } catch (e) {
    console.warn('[calib] solvePnpRansac failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function calibrateGuided(
  objectPoints: number[], imagePoints: number[], pointCounts: number[],
  projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean,
): ProjectorIntrinsicsResult | null {
  if (!native) return null;
  try {
    return native.calibrateProjectorGuided(objectPoints, imagePoints, pointCounts, projW, projH, initK, fixPrincipalPoint, fixAspect);
  } catch (e) {
    console.warn('[calib] calibrateProjectorGuided failed:', (e as Error)?.message ?? e);
    return null;
  }
}

// ---- native camera capture (OpenCV videoio / DirectShow) -------------------
// Bypasses Chromium's getUserMedia for cameras it can't start (e.g. the PS3 Eye's DirectShow source
// filter). Frames flow renderer ⇄ main over IPC; the grayscale buffer feeds detectBoard directly.

export function cameraOpen(index: number, width: number, height: number, fps: number, fourcc: string): boolean {
  if (!native) return false;
  try {
    return native.cameraOpen(index, width, height, fps, fourcc);
  } catch (e) {
    console.warn('[calib] cameraOpen failed:', (e as Error)?.message ?? e);
    return false;
  }
}

export function cameraGrab(): CameraFrame | null {
  if (!native) return null;
  try {
    const f = native.cameraGrabGray();
    if (!f) return null;
    // Hand the renderer a tightly-sliced ArrayBuffer (the napi Buffer may sit in a larger pool).
    const ab = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
    return { w: f.w, h: f.h, data: ab };
  } catch (e) {
    console.warn('[calib] cameraGrab failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function cameraClose(): void {
  if (!native) return;
  try {
    native.cameraClose();
  } catch (e) {
    console.warn('[calib] cameraClose failed:', (e as Error)?.message ?? e);
  }
}
