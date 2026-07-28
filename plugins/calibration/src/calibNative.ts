// Renderer-side typed wrapper over the calibration plugin's main IPC (the generic plugin bridge:
// window.artlux.pluginInvoke / pluginSend, channels 'plugin:calib:*'). Drop-in replacement for the
// former core window.artlux.calib* methods — SAME names, so a module only swaps `const api =
// window.artlux` → `const api = calibNative`. Returns null when the native addon is absent (the
// callers already null-check every result → graceful degrade).

import type {
  BoardDetectResult, ArucoDetection, CornerProjMap, ProjectorIntrinsicsResult,
  PnpResult, DenseMap, CameraSelfCal, CameraFrame, CameraMode,
} from '../../../shared/protocol';

async function inv<T>(ch: string, ...args: unknown[]): Promise<T | null> {
  const p = window.artlux?.pluginInvoke?.(ch, ...args);
  const r = p ? await p : null;
  return (r ?? null) as T | null;
}

export const calibAvailable = async (): Promise<boolean> => !!(await inv<boolean>('calib:available'));

export const calibDetectBoard = (image: ArrayBuffer, w: number, h: number, cols: number, rows: number) =>
  inv<BoardDetectResult>('calib:detect-board', image, w, h, cols, rows);

export const calibDetectAruco = (image: ArrayBuffer, w: number, h: number, dict: number) =>
  inv<ArucoDetection>('calib:detect-aruco', image, w, h, dict);

export const calibMapCorners = (captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, corners: number[], white: ArrayBuffer, black: ArrayBuffer) =>
  inv<CornerProjMap>('calib:map-corners', captures, captureCount, camW, camH, projW, projH, corners, white, black);

export const calibCalibrateProjector = (objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number) =>
  inv<ProjectorIntrinsicsResult>('calib:calibrate-projector', objectPoints, imagePoints, pointCounts, projW, projH);

export const calibSolvePnp = (objectPts: number[], imagePts: number[], k: number[], dist: number[]) =>
  inv<PnpResult>('calib:solve-pnp', objectPts, imagePts, k, dist);

export const calibDecodeDense = (captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, white: ArrayBuffer, black: ArrayBuffer, stride: number) =>
  inv<DenseMap>('calib:decode-dense', captures, captureCount, camW, camH, projW, projH, white, black, stride);

export const calibSolvePnpRansac = (objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number) =>
  inv<PnpResult>('calib:solve-pnp-ransac', objectPts, imagePts, k, dist, reprojErr);

export const calibCalibrateGuided = (objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean) =>
  inv<ProjectorIntrinsicsResult>('calib:calibrate-guided', objectPoints, imagePoints, pointCounts, projW, projH, initK, fixPrincipalPoint, fixAspect);

export const calibSelfCalibrate = (camX: number[], camY: number[], projX: number[], projY: number[], camW: number, camH: number, projW: number, projH: number) =>
  inv<CameraSelfCal>('calib:self-calibrate', camX, camY, projX, projY, camW, camH, projW, projH);

export const calibCameraOpen = async (index: number, width: number, height: number, fps: number, fourcc: string): Promise<boolean> =>
  !!(await inv<boolean>('calib:camera-open', index, width, height, fps, fourcc));

// Capture modes the device really advertises. `[]` (not null) whenever it can't be read, so callers
// can treat "no answer" and "nothing advertised" the same way: fall back to a static list.
export const calibCameraListModes = async (index: number): Promise<CameraMode[]> =>
  (await inv<CameraMode[]>('calib:camera-list-modes', index)) ?? [];

export const calibCameraGrab = () => inv<CameraFrame>('calib:camera-grab');
export const calibCameraGrabColor = () => inv<CameraFrame>('calib:camera-grab-color');
export const calibCameraSetProp = async (prop: string, value: number): Promise<boolean> => !!(await inv<boolean>('calib:camera-set-prop', prop, value));
export const calibCameraGetProp = (prop: string) => inv<number>('calib:camera-get-prop', prop);
export const calibCameraClose = (): void => { window.artlux?.pluginSend?.('calib:camera-close'); };
