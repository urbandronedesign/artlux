// The pose inference engine: owns the webcam + a MediaPipe PoseLandmarker (BlazePose) running IN THE
// RENDERER via WebAssembly, and feeds detections into poseStore. Refcounted by consumer key like the
// core camera source — it runs only while ≥1 MEDIAPIPE surface/clip wants it, and ONLY in the main
// editor window (projector windows receive detections over the projector bridge, never run inference).
//
// The whole module is lazy + fail-soft: @mediapipe/tasks-vision and its WASM/model assets are loaded
// on first use, and any failure (dep missing, assets absent, no camera, no GPU delegate) logs and
// disables pose tracking rather than crashing — the app-wide native-degradation contract.

import * as poseStore from './poseStore';
import type { Detection } from './poseStore';
import * as poseCamera from './poseCamera';
import { getHost } from './poseHost';

// Persisted plugin-local settings (under AppSettings.plugins.mediapipe — not a core field, since only
// this plugin reads them). Shared with poseSettings.tsx.
export interface MediaPipeSettings {
  cameraDeviceId?: string;
  model?: 'lite' | 'full' | 'heavy';   // BlazePose model complexity (accuracy vs speed)
  numPoses?: number;                    // max people to detect
  delegate?: 'GPU' | 'CPU';             // inference backend
  minConfidence?: number;               // detection/presence/tracking confidence threshold
}
type ResolvedCfg = Required<Omit<MediaPipeSettings, 'cameraDeviceId'>> & { cameraDeviceId?: string };

// ── Minimal structural types for the lazily-imported package (the real @mediapipe/tasks-vision types
// are structurally compatible). Kept local so tsc doesn't hard-require the dep to be installed. ──
interface MpLandmark { x: number; y: number; z: number; visibility?: number }
interface MpResult { landmarks: MpLandmark[][] }
interface MpLandmarker { detectForVideo(video: HTMLVideoElement, timestampMs: number): MpResult; close(): void }
interface MpFileset { /* opaque handle */ }
interface TasksVision {
  FilesetResolver: { forVisionTasks(wasmBase: string): Promise<MpFileset> };
  PoseLandmarker: { createFromOptions(fileset: MpFileset, opts: unknown): Promise<MpLandmarker> };
}

async function loadModule(): Promise<TasksVision | null> {
  try {
    // @ts-ignore — optional dependency resolved at runtime; may be absent in some builds/CI.
    const mod = await import('@mediapipe/tasks-vision');
    return mod as unknown as TasksVision;
  } catch (e) {
    console.warn('[mediapipe] @mediapipe/tasks-vision unavailable — pose tracking disabled', e);
    return null;
  }
}

let win: 'main' | 'projector' = 'main';
const consumers = new Set<string>();
let landmarker: MpLandmarker | null = null;
let running = false;
let starting = false;
let disabled = false;               // asset/module load failed — don't retry every reconcile
let lastError: string | null = null;
let raf = 0;
let lastVideoTime = -1;
let unsubSettings: (() => void) | null = null;
let cfgSig = '';

// fps/count telemetry for the debug panel.
let frames = 0;
let fpsWindowStart = 0;
let fps = 0;
let count = 0;

export function setWindow(w: 'main' | 'projector'): void { win = w; }

export function acquire(key: string): void { consumers.add(key); reconcile(); }
export function release(key: string): void { consumers.delete(key); reconcile(); }

function reconcile(): void {
  const want = win === 'main' && consumers.size > 0 && !disabled;
  if (want && !running && !starting) void startEngine();
  else if (!want && (running || starting)) stopEngine();
}

function readConfig(): ResolvedCfg {
  const s = getHost()?.settings.get() as { plugins?: { mediapipe?: MediaPipeSettings } } | undefined;
  const m = s?.plugins?.mediapipe ?? {};
  return {
    cameraDeviceId: m.cameraDeviceId,
    model: m.model ?? 'full',
    numPoses: Math.max(1, Math.min(6, m.numPoses ?? 2)),
    delegate: m.delegate ?? 'GPU',
    minConfidence: Math.max(0.1, Math.min(0.95, m.minConfidence ?? 0.5)),
  };
}
const sigOf = (c: ResolvedCfg): string => `${c.cameraDeviceId}|${c.model}|${c.numPoses}|${c.delegate}|${c.minConfidence}`;

// Resolve the local (offline) asset base. Assets live in the renderer public dir at /mediapipe/, so
// they resolve the same in dev (http://localhost:3000/mediapipe/) and packaged (file://…/mediapipe/).
function assetBase(): string { return new URL('mediapipe/', document.baseURI).href; }

async function startEngine(): Promise<void> {
  starting = true;
  lastError = null;
  try {
    const mod = await loadModule();
    if (!mod) { disabled = true; lastError = 'tasks-vision module unavailable'; return; }
    const cfg = readConfig();
    await poseCamera.start(cfg.cameraDeviceId);
    // Bail if everything was released while we awaited the camera.
    if (win !== 'main' || consumers.size === 0) { poseCamera.stop(); return; }

    const base = assetBase();
    const fileset = await mod.FilesetResolver.forVisionTasks(base + 'wasm');
    landmarker = await mod.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}models/pose_landmarker_${cfg.model}.task`, delegate: cfg.delegate },
      runningMode: 'VIDEO',
      numPoses: cfg.numPoses,
      minPoseDetectionConfidence: cfg.minConfidence,
      minPosePresenceConfidence: cfg.minConfidence,
      minTrackingConfidence: cfg.minConfidence,
    });
    if (win !== 'main' || consumers.size === 0) { stopEngine(); return; }

    running = true;
    lastVideoTime = -1;
    cfgSig = sigOf(cfg);
    fpsWindowStart = performance.now(); frames = 0;
    // Restart when a relevant setting (camera/model/poses/delegate/confidence) changes.
    unsubSettings = getHost()?.settings.subscribe(() => {
      const c = readConfig();
      if (sigOf(c) !== cfgSig) { cfgSig = sigOf(c); restart(); }
    }) ?? null;
    loop();
  } catch (e) {
    // Asset/model/GPU failures disable the feature (avoid a reconcile retry storm). A camera failure
    // is left retryable (re-acquire tries again) — distinguish by whether a landmarker was created.
    lastError = (e as Error)?.message ?? String(e);
    if (!landmarker) disabled = true;
    console.error('[mediapipe] engine start failed — pose tracking disabled', e);
    stopEngine();
  } finally {
    starting = false;
  }
}

function stopEngine(): void {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  unsubSettings?.(); unsubSettings = null;
  try { landmarker?.close(); } catch { /* ignore */ }
  landmarker = null;
  poseCamera.stop();
  running = false;
  count = 0; fps = 0;
  poseStore.ingest([]);
}

// Tear down and let reconcile() rebuild with fresh config (e.g. after a settings change).
export function restart(): void {
  if (!running && !starting) return;
  stopEngine();
  reconcile();
}

const HIP_L = 23, HIP_R = 24; // BlazePose left/right hip landmark indices → person centroid
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

// Map a MediaPipe result to store detections: flip Y to bottom-left origin, pick a representative
// position (hip midpoint when the hips are visible, else the landmark bbox centre), and average
// visibility for a confidence score.
function mapResult(res: MpResult): Detection[] {
  const out: Detection[] = [];
  for (const person of res.landmarks) {
    if (!person || !person.length) continue;
    const landmarks = person.map((p) => ({ x: p.x, y: 1 - p.y, z: p.z, visibility: p.visibility ?? 1 }));
    let u: number, v: number;
    const hl = landmarks[HIP_L], hr = landmarks[HIP_R];
    if (hl && hr && (hl.visibility + hr.visibility) > 0.6) { u = (hl.x + hr.x) / 2; v = (hl.y + hr.y) / 2; }
    else { let sx = 0, sy = 0; for (const p of landmarks) { sx += p.x; sy += p.y; } u = sx / landmarks.length; v = sy / landmarks.length; }
    let sc = 0; for (const p of landmarks) sc += p.visibility; sc /= landmarks.length;
    out.push({ u: clamp01(u), v: clamp01(v), score: sc, landmarks });
  }
  return out;
}

function loop(): void {
  raf = requestAnimationFrame(loop);
  const video = poseCamera.el();
  if (!video || !landmarker) return;
  // detectForVideo needs a NEW frame + a monotonic timestamp; skip if the frame hasn't advanced.
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let res: MpResult;
  try { res = landmarker.detectForVideo(video, performance.now()); }
  catch (e) { lastError = (e as Error)?.message ?? String(e); return; }
  const dets = mapResult(res);
  count = dets.length;
  poseStore.ingest(dets);
  // fps over a ~500ms window.
  frames++;
  const now = performance.now();
  if (now - fpsWindowStart >= 500) { fps = Math.round((frames * 1000) / (now - fpsWindowStart)); frames = 0; fpsWindowStart = now; }
}

export interface EngineStatus { running: boolean; disabled: boolean; error: string | null; fps: number; count: number; consumers: number }
export function status(): EngineStatus {
  return { running, disabled, error: lastError, fps, count, consumers: consumers.size };
}
