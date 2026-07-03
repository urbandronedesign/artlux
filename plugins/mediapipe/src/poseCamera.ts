// Webcam capture for MediaPipe pose inference. The plugin owns its OWN getUserMedia stream (like
// calibration's cvCamera) rather than sharing the core CAMERA surface source, so pose tracking never
// fights surface content for the device and can pick a different camera. Frames are pulled straight
// from the <video> element by poseEngine (PoseLandmarker.detectForVideo accepts an HTMLVideoElement).

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;

export interface CameraDevice { deviceId: string; label: string }

// Video input devices. Labels only populate after camera permission has been granted (i.e. after a
// successful start()), so the settings UI shows generic names until the engine has run once.
export async function enumerate(): Promise<CameraDevice[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
  } catch { return []; }
}

// Start (or restart) capture on the chosen device. Progressively relaxes constraints — a too-high
// `ideal` can make Chromium negotiate a mode it then fails to start (NotReadableError), so we retry
// 720p → 480p → bare {video:true}. Bails early only on a hard permission block. Throws on total failure.
export async function start(deviceId?: string): Promise<void> {
  stop();
  const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
  const attempts: Array<MediaTrackConstraints | boolean> = [
    { ...dev, width: { ideal: 1280 }, height: { ideal: 720 } },
    { ...dev, width: { ideal: 640 }, height: { ideal: 480 } },
    deviceId ? { deviceId: { exact: deviceId } } : true,
  ];
  let lastErr: unknown = null;
  for (const v of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); lastErr = null; break; }
    catch (e) { lastErr = e; const name = (e as DOMException)?.name; if (name === 'NotAllowedError' || name === 'SecurityError') break; }
  }
  if (!stream) throw lastErr;
  const vid = document.createElement('video');
  vid.srcObject = stream; vid.muted = true; vid.playsInline = true;
  await vid.play();
  video = vid;
}

export function stop(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (video) { video.srcObject = null; video = null; }
}

// The capture element once it has real frames, else null (PoseLandmarker needs videoWidth > 0).
export function el(): HTMLVideoElement | null {
  return video && video.readyState >= 2 && video.videoWidth > 0 ? video : null;
}

export function aspect(): number | null {
  return video && video.videoWidth > 0 ? video.videoWidth / video.videoHeight : null;
}

// The live MediaStream for a debug <video> preview (null while capture is stopped).
export function getStream(): MediaStream | null { return stream; }
