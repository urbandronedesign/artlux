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

import * as calibNative from './calibNative';

export type CaptureSource = 'browser' | 'native';

export interface CameraDevice { deviceId: string; label: string }
export interface GrayFrame { w: number; h: number; data: Uint8Array }
// Packed RGBA frame (w*h*4) for the colour preview. Display-only — detection/decode stay on GrayFrame.
export interface ColorFrame { w: number; h: number; data: Uint8ClampedArray }

// Reduce an RGBA colour frame to BT.601-ish luma (same weights as the native/gray paths), so a single
// colour grab can serve both the preview and board detection without a second camera read.
export function toGray(c: ColorFrame): GrayFrame {
  const px = c.w * c.h;
  const gray = new Uint8Array(px);
  for (let i = 0; i < px; i++) {
    gray[i] = (c.data[i * 4] * 77 + c.data[i * 4 + 1] * 150 + c.data[i * 4 + 2] * 29) >> 8;
  }
  return { w: c.w, h: c.h, data: gray };
}

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
    await startBrowser(opts);
  }
}

// --- native (OpenCV / DirectShow) -------------------------------------------
async function startNative(opts: StartOpts): Promise<void> {
  const api = calibNative;
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
async function startBrowser(opts: { deviceId?: string; width?: number; height?: number; fps?: number }): Promise<void> {
  const { deviceId, width, height, fps } = opts;
  const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
  const fpsC = fps ? { frameRate: { ideal: fps } } : {};
  // Prefer the requested mode (if any), then 720p, 480p, and finally bare {video:true}.
  const attempts: Array<MediaTrackConstraints | boolean> = [
    ...(width && height ? [{ ...dev, ...fpsC, width: { ideal: width }, height: { ideal: height } }] : []),
    { ...dev, ...fpsC, width: { ideal: 1280 }, height: { ideal: 720 } },
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
  if (nativeOpen) { calibNative.calibCameraClose(); nativeOpen = false; }
  nativeDims = { w: 0, h: 0 };
}

export function isNative(): boolean { return source === 'native'; }

// Set a camera capture property for decode SNR. `prop` is a source-agnostic name:
//   'autoexposure' | 'exposure' | 'gain' | 'gamma' | 'brightness'
// Native (OpenCV/DShow): forwarded to the addon's cap.set with the raw driver value (exposure is
// typically log2-seconds; disable auto first by setting 'autoexposure' to 0.25). Browser
// (getUserMedia): mapped to MediaStreamTrack constraints, gated on getCapabilities() — returns false
// (and silently no-ops) for unsupported props so the UI can grey out the slider.
export async function setProp(prop: string, value: number): Promise<boolean> {
  if (source === 'native') {
    return (await calibNative.calibCameraSetProp(prop, value)) ?? false;
  }
  const track = stream?.getVideoTracks()[0];
  if (!track || !track.applyConstraints) return false;
  // Capabilities aren't typed in lib.dom for these advanced props — probe loosely.
  const caps = track.getCapabilities?.() as Record<string, unknown> | undefined;
  const adv: Record<string, unknown> = {};
  switch (prop) {
    case 'autoexposure':
      if (caps && !('exposureMode' in caps)) return false;
      adv.exposureMode = value > 0 ? 'continuous' : 'manual';
      break;
    case 'exposure':
      if (caps && !('exposureTime' in caps)) return false;
      adv.exposureMode = 'manual'; adv.exposureTime = value;
      break;
    case 'gain':
      if (caps && !('iso' in caps)) return false;
      adv.iso = value;
      break;
    case 'brightness':
      if (caps && !('brightness' in caps)) return false;
      adv.brightness = value;
      break;
    case 'contrast':
      if (caps && !('contrast' in caps)) return false;
      adv.contrast = value;
      break;
    case 'saturation':
      if (caps && !('saturation' in caps)) return false;
      adv.saturation = value;
      break;
    case 'sharpness':
      if (caps && !('sharpness' in caps)) return false;
      adv.sharpness = value;
      break;
    case 'auto_wb':
      if (caps && !('whiteBalanceMode' in caps)) return false;
      adv.whiteBalanceMode = value > 0 ? 'continuous' : 'manual';
      break;
    case 'wb_temperature':
      if (caps && !('colorTemperature' in caps)) return false;
      adv.whiteBalanceMode = 'manual'; adv.colorTemperature = value;
      break;
    case 'autofocus':
      if (caps && !('focusMode' in caps)) return false;
      adv.focusMode = value > 0 ? 'continuous' : 'manual';
      break;
    case 'focus':
      if (caps && !('focusDistance' in caps)) return false;
      adv.focusMode = 'manual'; adv.focusDistance = value;
      break;
    case 'zoom':
      if (caps && !('zoom' in caps)) return false;
      adv.zoom = value;
      break;
    default:
      return false; // gamma etc. aren't exposed by getUserMedia
  }
  try {
    await track.applyConstraints({ advanced: [adv] } as MediaTrackConstraints);
    return true;
  } catch {
    return false;
  }
}

// Which capture props the current source supports, for greying out unsupported sliders. Native
// (OpenCV) can't report this reliably (driver-dependent, cap.set silently no-ops), so we return null
// → "show all, let the driver ignore what it can't do". Browser maps getCapabilities() keys to our
// source-agnostic prop names.
export async function supportedProps(): Promise<Set<string> | null> {
  if (source === 'native') return null;
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined;
  const out = new Set<string>();
  if (!caps) return out;
  const map: Record<string, string> = {
    exposure: 'exposureTime', autoexposure: 'exposureMode', gain: 'iso', brightness: 'brightness',
    contrast: 'contrast', saturation: 'saturation', sharpness: 'sharpness',
    auto_wb: 'whiteBalanceMode', wb_temperature: 'colorTemperature',
    autofocus: 'focusMode', focus: 'focusDistance', zoom: 'zoom',
  };
  for (const [p, k] of Object.entries(map)) if (k in caps) out.add(p);
  return out;
}

export interface PropRange { min: number; max: number; step: number }

// Real min/max/step per prop for the browser source (from getCapabilities) so the sliders match the
// driver's actual range and applyConstraints doesn't reject mid-range values. Native returns null →
// the panel uses its generic raw-value ranges (OpenCV doesn't report reliable bounds).
export async function propRanges(): Promise<Record<string, PropRange> | null> {
  if (source !== 'browser') return null;
  const track = stream?.getVideoTracks()[0];
  const caps = track?.getCapabilities?.() as Record<string, { min?: number; max?: number; step?: number }> | undefined;
  const out: Record<string, PropRange> = {};
  if (!caps) return out;
  const map: Record<string, string> = {
    exposure: 'exposureTime', gain: 'iso', brightness: 'brightness', contrast: 'contrast',
    saturation: 'saturation', sharpness: 'sharpness', wb_temperature: 'colorTemperature',
    focus: 'focusDistance', zoom: 'zoom',
  };
  for (const [p, k] of Object.entries(map)) {
    const c = caps[k];
    if (c && typeof c.min === 'number' && typeof c.max === 'number') out[p] = { min: c.min, max: c.max, step: c.step ?? 1 };
  }
  return out;
}

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
    const f = await calibNative.calibCameraGrab();
    if (!f) return null;
    nativeDims = { w: f.w, h: f.h };
    return { w: f.w, h: f.h, data: new Uint8Array(f.data) };
  }
  return grabBrowser();
}

// Grab the current frame as a packed RGBA buffer for the colour preview (point-picking needs real
// colour). Native: the addon swizzles BGR→RGBA. Browser: the <video> is already colour, so we read the
// canvas RGBA directly (no luma reduction). Returns null until a frame is available.
export async function grabColor(): Promise<ColorFrame | null> {
  if (source === 'native') {
    if (!nativeOpen) return null;
    const f = await calibNative.calibCameraGrabColor();
    if (!f) return null;
    nativeDims = { w: f.w, h: f.h };
    return { w: f.w, h: f.h, data: new Uint8ClampedArray(f.data) };
  }
  if (!video || !video.videoWidth) return null;
  const w = video.videoWidth, h = video.videoHeight;
  if (!canvas) canvas = document.createElement('canvas');
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

// Read a camera property's current value to seed the UI sliders. Native: forwarded to OpenCV cap.get.
// Browser: pulled from the live track settings. Returns null when unknown/unsupported.
export async function getProp(prop: string): Promise<number | null> {
  if (source === 'native') {
    return (await calibNative.calibCameraGetProp(prop)) ?? null;
  }
  const track = stream?.getVideoTracks()[0];
  const s = track?.getSettings?.() as Record<string, unknown> | undefined;
  if (!s) return null;
  const key: Record<string, string> = {
    exposure: 'exposureTime', gain: 'iso', brightness: 'brightness', contrast: 'contrast',
    saturation: 'saturation', sharpness: 'sharpness', wb_temperature: 'colorTemperature',
    focus: 'focusDistance', zoom: 'zoom',
  };
  const v = s[key[prop] ?? prop];
  return typeof v === 'number' ? v : null;
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
