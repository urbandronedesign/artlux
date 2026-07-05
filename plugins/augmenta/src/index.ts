// Augmenta tracking plugin — public barrel.
//
// Host code imports the plugin's modules ONLY through this barrel (one alias path:
// '@artlux/plugin-augmenta'); the plugin's own files import each other relatively. This keeps a
// SINGLE module identity for every singleton (augmentaStore, motion, …): if host code deep-imported
// via the alias while internals imported relatively, the bundler would treat them as two modules and
// duplicate the singleton — the OSC ingest would write one store while the projector bridge reads an
// empty other (the exact bug that hit the LiDAR trackingStore). `sideEffects:false` (package.json)
// lets each window tree-shake the namespaces it doesn't use.
//
// Mirrors plugins/mediapipe (single-source tracking template): a render-free pub/sub store, a
// content-source drawable, a projector data+GPU channel, a 3D scene-viz overlay, a debug monitor,
// and a settings section — but fed by an Augmenta box over OSC instead of a webcam + BlazePose. The
// blob render math (disc + heading + comet trail) is the LiDAR look; the store shape (whole-frame
// object list) is the MediaPipe shape, because Augmenta emits a full object set per OSC bundle.

export * as augmentaStore from './augmentaStore';
export * as motion from './motion';
export * as augmentaRenderer from './augmentaRenderer';
export * as augmentaDrawable from './augmentaDrawable';
export * as augmentaProjector from './augmentaProjector';
export * as blobPass from './blobPass';

export type { AugmentaSnapshot, AugmentaObject, AugmentaScene } from './augmentaStore';
export type { LiveTrack } from './motion';
export type { BlobInst } from './blobPass';

// Plugin entry (registered by the host's activateRendererPlugins).
export { plugin } from './plugin.renderer';
