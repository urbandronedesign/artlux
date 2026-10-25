import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  BoardDetectResult, ArucoDetection, CornerProjMap, ProjectorIntrinsicsResult, PnpResult, CameraFrame, CameraMode, DenseMap, CameraSelfCal,
} from '../../../shared/protocol';

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
  /** Detect ArUco fiducials → ids + sub-pixel corners (one-click recalibration). */
  detectAruco(image: Buffer, w: number, h: number, dict: number): ArucoDetection;
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
  /** Board-free camera intrinsics from dense camera↔projector correspondences (focal-from-F). */
  selfCalibrateStereo(camX: number[], camY: number[], projX: number[], projY: number[], camW: number, camH: number, projW: number, projH: number): CameraSelfCal;
  /** Open a camera by index via OpenCV's DirectShow backend (for cameras getUserMedia can't drive). */
  cameraOpen(index: number, width: number, height: number, fps: number, fourcc: string): boolean;
  /** Modes the device at `index` actually advertises (DirectShow); empty when it can't be read. */
  cameraListModes(index: number): CameraMode[];
  /** Grab one grayscale frame (Buffer of w*h bytes) from the open camera, or null if none ready. */
  cameraGrabGray(): { w: number; h: number; data: Buffer } | null;
  /** Grab one RGBA frame (Buffer of w*h*4 bytes) from the open camera, or null if none ready. */
  cameraGrabRgba(): { w: number; h: number; data: Buffer } | null;
  /** Release the open camera. */
  cameraClose(): void;
  /** Set a capture property on the open camera; false if rejected/none open. */
  cameraSetProp(prop: string, value: number): boolean;
  /** Read a capture property's current value; null if no camera / unknown / unsupported. */
  cameraGetProp(prop: string): number | null;
}

const req = createRequire(__filename);

function candidates(): string[] {
  return [
    join(process.resourcesPath ?? '', 'calib.node'), // packaged (extraResources)
    join(process.cwd(), 'native/calib/calib.node'),
    join(__dirname, '../../native/calib/calib.node'),
  ];
}

// Loaded on FIRST USE, not at import (suite plan Phase 1). Requiring calib.node maps the 65 MB
// opencv_world4110.dll into main, and the main plugin activates in every launch — so a show that never
// calibrates used to pay for OpenCV from the first second. Now only an authoring call (a wizard asking
// `calib:available`, a solve, the camera, an unattended recalibration) loads it. `undefined` = not
// tried yet; `null` = tried and failed — never retried, so a missing DLL logs once, not per frame.
let loaded: CalibNative | null | undefined;

function native(): CalibNative | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  for (const p of candidates()) {
    try {
      if (existsSync(p)) { loaded = req(p) as CalibNative; break; }
    } catch (e) {
      console.warn('[calib] native addon load failed at', p, e);
    }
  }
  console.log(loaded ? '[calib] native OpenCV addon loaded' : '[calib] native OpenCV addon unavailable (calibration disabled)');
  return loaded;
}

/** Loads the addon if it was not tried yet — call it only where calibration is about to be used. */
export function isAvailable(): boolean {
  return !!native();
}

/**
 * The addon's state WITHOUT loading it, for the startup splash and the machine log: 'loaded',
 * 'missing' (load failed, or no calib.node on disk), or 'present' (on disk, not loaded yet — the
 * normal state of a show that has not calibrated).
 */
export function addonState(): 'loaded' | 'present' | 'missing' {
  if (loaded) return 'loaded';
  if (loaded === null) return 'missing';
  // The DLL ships beside calib.node (package.json extraResources; native/calib/ in dev) and is the
  // usual venue-PC failure, so it is checked here too — the splash keeps warning without loading it.
  return candidates().some((p) => existsSync(p) && existsSync(join(dirname(p), 'opencv_world4110.dll')))
    ? 'present' : 'missing';
}

export function detectBoard(image: Buffer, w: number, h: number, cols: number, rows: number): BoardDetectResult | null {
  const n = native();
  if (!n) return null;
  try {
    return n.detectBoard(image, w, h, cols, rows);
  } catch (e) {
    console.warn('[calib] detectBoard failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function detectAruco(image: Buffer, w: number, h: number, dict: number): ArucoDetection | null {
  const n = native();
  if (!n?.detectAruco) return null;
  try {
    return n.detectAruco(image, w, h, dict);
  } catch (e) {
    console.warn('[calib] detectAruco failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function mapCorners(
  captures: Buffer, captureCount: number, camW: number, camH: number,
  projW: number, projH: number, corners: number[], white: Buffer, black: Buffer,
): CornerProjMap | null {
  const n = native();
  if (!n) return null;
  try {
    return n.mapCornersToProjector(captures, captureCount, camW, camH, projW, projH, corners, white, black);
  } catch (e) {
    console.warn('[calib] mapCornersToProjector failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function calibrateProjector(
  objectPoints: number[], imagePoints: number[], pointCounts: number[],
  projW: number, projH: number,
): ProjectorIntrinsicsResult | null {
  const n = native();
  if (!n) return null;
  try {
    return n.calibrateProjector(objectPoints, imagePoints, pointCounts, projW, projH);
  } catch (e) {
    console.warn('[calib] calibrateProjector failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function solvePnp(objectPts: number[], imagePts: number[], k: number[], dist: number[]): PnpResult | null {
  const n = native();
  if (!n) return null;
  try {
    return n.solvePnp(objectPts, imagePts, k, dist);
  } catch (e) {
    console.warn('[calib] solvePnp failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function decodeDense(
  captures: Buffer, captureCount: number, camW: number, camH: number,
  projW: number, projH: number, white: Buffer, black: Buffer, stride: number,
): DenseMap | null {
  const n = native();
  if (!n) return null;
  try {
    return n.decodeDenseMap(captures, captureCount, camW, camH, projW, projH, white, black, stride);
  } catch (e) {
    console.warn('[calib] decodeDenseMap failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function solvePnpRansac(objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number): PnpResult | null {
  const n = native();
  if (!n) return null;
  try {
    return n.solvePnpRansac(objectPts, imagePts, k, dist, reprojErr);
  } catch (e) {
    console.warn('[calib] solvePnpRansac failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function calibrateGuided(
  objectPoints: number[], imagePoints: number[], pointCounts: number[],
  projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean,
): ProjectorIntrinsicsResult | null {
  const n = native();
  if (!n) return null;
  try {
    return n.calibrateProjectorGuided(objectPoints, imagePoints, pointCounts, projW, projH, initK, fixPrincipalPoint, fixAspect);
  } catch (e) {
    console.warn('[calib] calibrateProjectorGuided failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function selfCalibrate(
  camX: number[], camY: number[], projX: number[], projY: number[],
  camW: number, camH: number, projW: number, projH: number,
): CameraSelfCal | null {
  const n = native();
  if (!n) return null;
  try {
    return n.selfCalibrateStereo(camX, camY, projX, projY, camW, camH, projW, projH);
  } catch (e) {
    console.warn('[calib] selfCalibrateStereo failed:', (e as Error)?.message ?? e);
    return null;
  }
}

// ---- native camera capture (OpenCV videoio / DirectShow) -------------------
// Bypasses Chromium's getUserMedia for cameras it can't start (e.g. the PS3 Eye's DirectShow source
// filter). Frames flow renderer ⇄ main over IPC; the grayscale buffer feeds detectBoard directly.

export function cameraOpen(index: number, width: number, height: number, fps: number, fourcc: string): boolean {
  const n = native();
  if (!n) return false;
  try {
    return n.cameraOpen(index, width, height, fps, fourcc);
  } catch (e) {
    console.warn('[calib] cameraOpen failed:', (e as Error)?.message ?? e);
    return false;
  }
}

// Modes the device really advertises, straight from DirectShow. Never throws and never opens the
// camera: an addon without the export (an older prebuilt .node) or a driver we can't introspect both
// yield [], and the caller falls back to its static list — i.e. exactly the pre-enumeration behaviour.
export function cameraListModes(index: number): CameraMode[] {
  const n = native();
  if (!n?.cameraListModes) return [];
  try {
    return n.cameraListModes(index) ?? [];
  } catch (e) {
    console.warn('[calib] cameraListModes failed:', (e as Error)?.message ?? e);
    return [];
  }
}

export function cameraGrab(): CameraFrame | null {
  const n = native();
  if (!n) return null;
  try {
    const f = n.cameraGrabGray();
    if (!f) return null;
    // Hand the renderer a tightly-sliced ArrayBuffer (the napi Buffer may sit in a larger pool).
    const ab = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
    return { w: f.w, h: f.h, data: ab };
  } catch (e) {
    console.warn('[calib] cameraGrab failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function cameraGrabColor(): CameraFrame | null {
  const n = native();
  if (!n?.cameraGrabRgba) return null;
  try {
    const f = n.cameraGrabRgba();
    if (!f) return null;
    // Hand the renderer a tightly-sliced ArrayBuffer (the napi Buffer may sit in a larger pool).
    const ab = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength);
    return { w: f.w, h: f.h, data: ab };
  } catch (e) {
    console.warn('[calib] cameraGrabColor failed:', (e as Error)?.message ?? e);
    return null;
  }
}

export function cameraClose(): void {
  // Never LOADS the addon: deactivate() calls this at every quit, and an addon that was never loaded
  // has no camera open.
  const n = loaded;
  if (!n) return;
  try {
    n.cameraClose();
  } catch (e) {
    console.warn('[calib] cameraClose failed:', (e as Error)?.message ?? e);
  }
}

export function cameraSetProp(prop: string, value: number): boolean {
  const n = native();
  if (!n?.cameraSetProp) return false;
  try {
    return n.cameraSetProp(prop, value);
  } catch (e) {
    console.warn('[calib] cameraSetProp failed:', (e as Error)?.message ?? e);
    return false;
  }
}

export function cameraGetProp(prop: string): number | null {
  const n = native();
  if (!n?.cameraGetProp) return null;
  try {
    return n.cameraGetProp(prop) ?? null;
  } catch (e) {
    console.warn('[calib] cameraGetProp failed:', (e as Error)?.message ?? e);
    return null;
  }
}
