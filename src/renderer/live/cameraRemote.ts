// The camera inspector's answers in a PANEL WINDOW (E5/W5): asked of the editor, which runs the capture.
//
// See services/cameraAccess.ts for why the inspector cannot ask a camera directly here. Each answer
// comes from live/coreStreams.ts in the editor:
//
//   info    the `camera.info` stream, one subscription per device id, opened on the first ask and kept
//           for the window's life (an inspector flips between a handful of devices at most). `info()`
//           must answer synchronously, so it returns the last sample, and "off" before the first one —
//           the editor's own answer for a device nothing has opened yet.
//   list    a call, so the labels are the editor's: Chromium withholds device labels until a capture
//           has succeeded IN THAT PAGE, and this page never captures — its own list would read
//           "Camera 1 / 2 / 3" beside an editor that names them.
//   retry / preview   calls; fire-and-forget like the editor's own (a failed preview is just a frame
//           that did not change).

import { liveClient } from './client';
import type { CameraAccess, CameraDevice, CameraInfo } from '../services/cameraAccess';

const OFF: CameraInfo = { state: 'off', error: null, capabilities: null, settings: null };
const last = new Map<string, CameraInfo>();

export const remoteCameraAccess: CameraAccess = {
  async list() {
    try { return ((await liveClient.action('camera.list', [])) as CameraDevice[] | undefined) ?? []; }
    catch { return []; }
  },
  info(deviceId) {
    if (!last.has(deviceId)) {
      last.set(deviceId, OFF);
      liveClient.subscribe('camera.info', deviceId, (v) => { last.set(deviceId, (v as CameraInfo) ?? OFF); });
    }
    return last.get(deviceId)!;
  },
  retry(deviceId) { void liveClient.action('camera.retry', [deviceId]).catch(() => {}); },
  preview(deviceId, name, value) { void liveClient.action('camera.preview', [deviceId, name, value]).catch(() => {}); },
};
