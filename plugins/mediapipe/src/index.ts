// MediaPipe pose-tracking plugin — public barrel.
//
// Host code imports the plugin's modules ONLY through this barrel (one alias path:
// '@artlux/plugin-mediapipe'); the plugin's own files import each other relatively. This keeps a
// SINGLE module identity for every singleton (poseStore, poseEngine, …): if host code deep-imported
// via the alias while internals imported relatively, the bundler would treat them as two modules and
// duplicate the singleton — the camera engine would write one store while the projector bridge reads
// an empty other. `sideEffects:false` (package.json) lets each window tree-shake the namespaces it
// doesn't use, so the heavy MediaPipe WASM engine never bloats the projector bundle.
//
// Mirrors plugins/lidar-tracking exactly (the canonical renderer-only tracking-plugin template): a
// render-free pub/sub store, a content-source drawable, a projector data+GPU channel, a scene-viz
// overlay, and a debug panel — but fed by a webcam + BlazePose instead of LiDAR blobs over OSC.

export * as poseStore from './poseStore';
export * as poseTracking from './poseTracking';
export * as poseRenderer from './poseRenderer';
export * as poseDrawable from './poseDrawable';
export * as poseProjector from './poseProjector';
export * as poseEngine from './poseEngine';
export * as posePass from './posePass';

export type { PoseSnapshot, Detection, PoseLandmark } from './poseStore';
export type { LiveTrack } from './poseTracking';
export type { PoseInst } from './posePass';

// Plugin entry (registered by the host's activateRendererPlugins).
export { plugin } from './plugin.renderer';
