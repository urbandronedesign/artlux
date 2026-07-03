// Camera pose store — the renderer-side sink for BlazePose detections produced by poseEngine.
// Singleton pub/sub like the LiDAR trackingStore: render-free, so high-rate pose updates never
// trigger React re-renders. Consumers (the stage drawable, projector render, 3D viz) subscribe and
// read the current detections; poseTracking then assigns stable ids + smooths them for display.
//
// Unlike the LiDAR OSC protocol (per-slot leaf messages accumulated over time), MediaPipe delivers a
// COMPLETE set of detections per inference call, so `ingest()` replaces the whole array wholesale.
// Coordinates are normalized [0..1] with origin BOTTOM-LEFT (Y up) — the same convention as the blob
// system — so poseRenderer can reuse the LiDAR transformUV / instances math unchanged.

// A single BlazePose landmark, converted to the store's bottom-left-origin normalized space.
export interface PoseLandmark {
  x: number;          // normalized x [0..1], origin left
  y: number;          // normalized y [0..1], origin BOTTOM (already flipped from MediaPipe's top-left)
  z: number;          // relative depth (MediaPipe's model space; smaller = closer to camera)
  visibility: number; // 0..1 landmark visibility/confidence
}

// One detected person for a single inference frame. No stable id yet — poseTracking assigns ids by
// matching detections across frames (MediaPipe multi-pose gives no cross-frame identity).
export interface Detection {
  u: number;               // representative position x [0..1] (hip midpoint, else bbox centre)
  v: number;               // representative position y [0..1], origin bottom-left
  score: number;           // mean landmark visibility for the person (0..1)
  landmarks?: PoseLandmark[]; // full 33-landmark set (optional; drives the skeleton overlay)
}

// A flat, serializable copy of the latest detections — bridged from the camera-owning main window to
// projector output windows showing MEDIAPIPE content (which never run inference themselves).
export interface PoseSnapshot {
  detections: Detection[];
}

// Unique module-identity marker: the barrel rule (see index.ts) requires this store to be a single
// instance per window bundle. `npm run verify:plugins` (and a manual grep of the built bundle) checks
// this string appears exactly once per window — two copies mean host code deep-imported past the barrel.
export const MEDIAPIPE_STORE_MARKER = '__artlux_mediapipe_poseStore_v1__';

let detections: Detection[] = [];
let updatedAt = 0;
const subs = new Set<() => void>();

// Replay/simulation override (parity with the LiDAR store): while an external source drives the store,
// live engine ingests are swallowed. Unused in v1 (no takes yet) but kept so record/replay can bolt on.
let replaySource = false;
export function setReplaySource(on: boolean): void { replaySource = on; }
export function isReplaySource(): boolean { return replaySource; }

// Coalesce notifications to one per animation frame — a pose frame lands as one ingest, but multiple
// consumers + the projector bridge subscribe, so batch their wakeups like the LiDAR store does.
let dirty = false;
let rafId = 0;
function markDirty(): void {
  dirty = true;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!dirty) return;
    dirty = false;
    subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[mediapipe] subscriber error', e); } });
  });
}

// Replace the current detections from a fresh inference frame (poseEngine, main window).
export function ingest(dets: Detection[]): void {
  if (replaySource) return; // an external source owns the store
  detections = dets;
  updatedAt = performance.now();
  markDirty();
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function getDetections(): Detection[] { return detections; }
export function lastUpdatedAt(): number { return updatedAt; }

// Serialize for bridging to projector windows. Drop everything if the last frame went stale (the
// camera stopped / dropped out) so a projector doesn't freeze on the final frame's ghosts.
const STALE_TTL_MS = 500;
export function snapshot(): PoseSnapshot {
  if (performance.now() - updatedAt > STALE_TTL_MS) return { detections: [] };
  return { detections: detections.map((d) => ({ ...d, landmarks: d.landmarks?.map((l) => ({ ...l })) })) };
}

// Replace the store from a bridged snapshot (projector window). Stamp updatedAt=now so the applied
// frame counts as fresh for this window's own stale checks / trackers.
export function applySnapshot(snap: PoseSnapshot): void {
  detections = snap.detections.map((d) => ({ ...d, landmarks: d.landmarks?.map((l) => ({ ...l })) }));
  updatedAt = performance.now();
  markDirty();
}
