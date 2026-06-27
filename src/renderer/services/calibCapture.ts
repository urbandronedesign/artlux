// Calibration camera capture: a dedicated getUserMedia stream + still-grab path for structured-light
// projector calibration. Separate from surfaceMedia's single surface camera so calibration doesn't
// fight surface content for the device. The camera is only used during the intrinsics phase.

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let canvas: HTMLCanvasElement | null = null;

export interface CameraDevice { deviceId: string; label: string }

// List video input devices. Labels are only populated once camera permission has been granted, so
// call this after start() for meaningful names (before that, labels fall back to a generic string).
export async function enumerate(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter(d => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

// Start (or restart) the calibration camera. Requests 720p (plenty for board detection, lighter on
// the structured-light capture IPC) with an `ideal` hint, falling back to unconstrained video if a
// webcam rejects the hints — so we only fail on a real permission/device problem. getUserMedia errors
// propagate (NotAllowedError = OS/Windows privacy block, NotReadableError = camera in use,
// NotFoundError = none) for the caller to map to a clear message.
export async function start(deviceId?: string): Promise<void> {
  stop();
  const base: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } };
  if (deviceId) base.deviceId = { exact: deviceId };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
  } catch (e) {
    if ((e as DOMException)?.name === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
    } else {
      throw e;
    }
  }
  const v = document.createElement('video');
  v.srcObject = stream; v.muted = true; v.playsInline = true;
  await v.play();
  video = v;
}

export function stop(): void {
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (video) { video.srcObject = null; video = null; }
}

export function getStream(): MediaStream | null { return stream; }

export function dims(): { w: number; h: number } {
  return video ? { w: video.videoWidth, h: video.videoHeight } : { w: 0, h: 0 };
}

// Grab the current camera frame as a single-channel grayscale buffer (BT.601-ish luma), at the
// camera's native resolution. Returns null until the stream has a frame. Used for both board
// detection and the Gray-code captures (the native addon accepts 1-channel buffers).
export function grabGray(): { w: number; h: number; data: Uint8Array } | null {
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
