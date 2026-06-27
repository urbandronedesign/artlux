// Calibration camera capture for structured-light projector calibration. Two interchangeable sources:
//
//   * 'browser' — a dedicated getUserMedia stream (separate from surfaceMedia so calibration doesn't
//     fight surface content for the device). Works for any UVC webcam.
//   * 'native'  — OpenCV's videoio DirectShow backend in the native addon, driven over IPC. For
//     cameras Chromium's getUserMedia can't start — notably the PS3 Eye, whose user-mode DirectShow
//     source filter delivers to OpenCV but throws NotReadableError in getUserMedia. OpenCV's DSHOW
//     addresses devices by INDEX only (no names), so the wizard exposes an index picker like vvvv.
//
// Both expose the same `grab()` → grayscale frame, which feeds detectBoard / mapCorners unchanged.

export type CaptureSource = 'browser' | 'native';

export interface CameraDevice { deviceId: string; label: string }
export interface GrayFrame { w: number; h: number; data: Uint8Array }

export interface StartOpts {
  source: CaptureSource;
  deviceId?: string;                       // browser
  index?: number;                          // native (DirectShow device index)
  width?: number; height?: number;         // native capture hints
  fps?: number; fourcc?: string;           // native capture hints (e.g. 'MJPG')
}

let source: CaptureSource = 'browser';

// browser-source state
let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;

// native-source state
let nativeOpen = false;
let nativeDims = { w: 0, h: 0 };

// List video input devices (browser/getUserMedia). Labels are only populated once camera permission
// has been granted, so call this after a browser start() for meaningful names. Native (OpenCV/DShow)
// devices are not enumerable here — they're addressed by index.
export async function enumerate(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(d => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

// Start (or restart) the calibration camera from the chosen source.
export async function start(opts: StartOpts): Promise<void> {
  stop();
  source = opts.source;
  if (source === 'native') {
    await startNative(opts);
  } else {
    await startBrowser(opts.deviceId);
  }
}

// --- native (OpenCV / DirectShow) -------------------------------------------
async function startNative(opts: StartOpts): Promise<void> {
  const api = window.artlux;
  if (!api?.calibCameraOpen) throw new Error('calibration addon unavailable');
  const w = opts.width ?? 1280, h = opts.height ?? 720, fps = opts.fps ?? 60, fourcc = opts.fourcc ?? 'MJPG';
  const ok = await api.calibCameraOpen(opts.index ?? 0, w, h, fps, fourcc);
  if (!ok) throw new Error(`could not open OpenCV camera at index ${opts.index ?? 0}`);
  nativeOpen = true;
  // Pull one frame to learn the negotiated resolution (and confirm it delivers).
  const f = await api.calibCameraGrab();
  if (f) nativeDims = { w: f.w, h: f.h };
}

// Start (or restart) a browser camera. Tries 720p first, then progressively relaxes the constraints.
// Limited cameras only advertise a few modes, and a too-high `ideal` can make Chromium negotiate a
// mode it then fails to *start* with NotReadableError (not OverconstrainedError), so a single fallback
// isn't enough. We retry at 640×480 and finally bare `{video:true}`, only bailing out early on a hard
// permission block. The final error propagates so the caller can map it.
async function startBrowser(deviceId?: string): Promise<void> {
  const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
  const attempts: Array<MediaTrackConstraints | boolean> = [
    { ...dev, width: { ideal: 1280 }, height: { ideal: 720 } },
    { ...dev, width: { ideal: 640 }, height: { ideal: 480 } },
    deviceId ? { deviceId: { exact: deviceId } } : true,
  ];
  let lastErr: unknown = null;
  for (const v of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const name = (e as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') break;
    }
  }
  if (!stream) throw lastErr;
  const vid = document.createElement('video');
  vid.srcObject = stream; vid.muted = true; vid.playsInline = true;
  await vid.play();
  video = vid;
}

export function stop(): void {
  // browser
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (video) { video.srcObject = null; video = null; }
  // native
  if (nativeOpen) { window.artlux?.calibCameraClose?.(); nativeOpen = false; }
  nativeDims = { w: 0, h: 0 };
}

export function isNative(): boolean { return source === 'native'; }

// The browser MediaStream for a <video> preview (null in native mode — use grab()+canvas instead).
export function getStream(): MediaStream | null { return source === 'browser' ? stream : null; }

export function dims(): { w: number; h: number } {
  if (source === 'native') return nativeDims;
  return video ? { w: video.videoWidth, h: video.videoHeight } : { w: 0, h: 0 };
}

// Grab the current frame as a single-channel grayscale buffer (BT.601-ish luma), source-agnostic.
// Returns null until a frame is available. Used for board detection, the live preview, and the
// Gray-code captures (the native addon accepts 1-channel buffers).
export async function grab(): Promise<GrayFrame | null> {
  if (source === 'native') {
    if (!nativeOpen) return null;
    const f = await window.artlux?.calibCameraGrab?.();
    if (!f) return null;
    nativeDims = { w: f.w, h: f.h };
    return { w: f.w, h: f.h, data: new Uint8Array(f.data) };
  }
  return grabBrowser();
}

function grabBrowser(): GrayFrame | null {
  if (!video || !video.videoWidth) return null;
  const w = video.videoWidth, h = video.videoHeight;
  if (!canvas) canvas = document.createElement('canvas');
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  }
  return { w, h, data: gray };
}
