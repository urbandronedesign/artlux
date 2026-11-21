// What the camera inspector may ask about a camera (E5/W5) — one seam, two implementations.
//
// The CAMERA content inspector (components/CameraSettings.tsx) shows which device, the format it
// actually negotiated, the device's own controls, and Retry. Every one of those answers lives where
// the capture runs: the editor's content source (services/contentSource.ts), which owns the
// MediaStreamTrack. A panel window runs no content source — opening a second capture of the same
// device there would fight the editor for it, and the window's own idle copy would say "off" about a
// camera that is live on the stage. So the inspector asks THIS module, never contentSource:
//
//   - in the editor (and any window that runs the content source), contentSource installs itself here
//     at module scope — the same functions the inspector used to import directly;
//   - in a panel window, panel.tsx installs live/cameraRemote.ts, which asks the editor over the live
//     channel (a `camera.info` stream and `camera.*` calls, live/coreStreams.ts).
//
// It imports nothing on purpose: this file is in the panel window's import graph.

export interface CameraDevice { deviceId: string; label: string }

export interface CameraInfo {
  state: 'off' | 'starting' | 'live' | 'error';
  error: string | null;
  capabilities: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
}

export interface CameraAccess {
  /** The video inputs, as the window that captures sees them (labels appear only after a capture). */
  list(): Promise<CameraDevice[]>;
  /** What the device is doing now. Synchronous — the inspector polls it. */
  info(deviceId: string): CameraInfo;
  retry(deviceId: string): void;
  /** Apply a control value to the running track without committing it to the project. */
  preview(deviceId: string, name: string, value: number | string): void;
}

const OFF: CameraInfo = { state: 'off', error: null, capabilities: null, settings: null };

// Until something installs itself this answers "nothing is running", which is the truth for a window
// that has neither the content source nor a link to the editor.
let impl: CameraAccess = {
  list: async () => [],
  info: () => OFF,
  retry: () => {},
  preview: () => {},
};

export function setCameraAccess(a: CameraAccess): void { impl = a; }

export const cameraAccess: CameraAccess = {
  list: () => impl.list(),
  info: (id) => impl.info(id),
  retry: (id) => impl.retry(id),
  preview: (id, name, value) => impl.preview(id, name, value),
};
