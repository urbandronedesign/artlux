// Calibration plugin — main-process activation. Owns the native OpenCV addon (calib.node) and wires
// its solves + camera control over the generic plugin bridge (channels 'calib:*'). Mirrors the arg
// conversion of the former core CALIB_* handlers (ArrayBuffer → Buffer for image/capture payloads).

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as calib from './calibManager';

const buf = (a: unknown) => Buffer.from(a as ArrayBuffer);

export const plugin: MainPlugin = {
  manifest: { id: 'calibration', name: 'Projector Calibration', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;
    ipc.handle('calib:available', () => calib.isAvailable());
    ipc.handle('calib:detect-board', (image, w, h, cols, rows) => calib.detectBoard(buf(image), w as number, h as number, cols as number, rows as number));
    ipc.handle('calib:detect-aruco', (image, w, h, dict) => calib.detectAruco(buf(image), w as number, h as number, dict as number));
    ipc.handle('calib:map-corners', (captures, count, camW, camH, projW, projH, corners, white, black) =>
      calib.mapCorners(buf(captures), count as number, camW as number, camH as number, projW as number, projH as number, corners as number[], buf(white), buf(black)));
    ipc.handle('calib:calibrate-projector', (obj, img, counts, projW, projH) => calib.calibrateProjector(obj as number[], img as number[], counts as number[], projW as number, projH as number));
    ipc.handle('calib:solve-pnp', (obj, img, k, dist) => calib.solvePnp(obj as number[], img as number[], k as number[], dist as number[]));
    ipc.handle('calib:decode-dense', (captures, count, camW, camH, projW, projH, white, black, stride) =>
      calib.decodeDense(buf(captures), count as number, camW as number, camH as number, projW as number, projH as number, buf(white), buf(black), stride as number));
    ipc.handle('calib:solve-pnp-ransac', (obj, img, k, dist, reproj) => calib.solvePnpRansac(obj as number[], img as number[], k as number[], dist as number[], reproj as number));
    ipc.handle('calib:calibrate-guided', (obj, img, counts, projW, projH, initK, fixPP, fixAspect) =>
      calib.calibrateGuided(obj as number[], img as number[], counts as number[], projW as number, projH as number, initK as number[], fixPP as boolean, fixAspect as boolean));
    ipc.handle('calib:self-calibrate', (camX, camY, projX, projY, camW, camH, projW, projH) =>
      calib.selfCalibrate(camX as number[], camY as number[], projX as number[], projY as number[], camW as number, camH as number, projW as number, projH as number));
    ipc.handle('calib:camera-open', (index, width, height, fps, fourcc) => calib.cameraOpen(index as number, width as number, height as number, fps as number, fourcc as string));
    ipc.handle('calib:camera-grab', () => calib.cameraGrab());
    ipc.handle('calib:camera-grab-color', () => calib.cameraGrabColor());
    ipc.handle('calib:camera-set-prop', (prop, value) => calib.cameraSetProp(prop as string, value as number));
    ipc.handle('calib:camera-get-prop', (prop) => calib.cameraGetProp(prop as string));
    ipc.on('calib:camera-close', () => calib.cameraClose());
  },

  deactivate(): void { try { calib.cameraClose(); } catch { /* addon absent */ } },
};
