// LiDAR tracking plugin — public barrel.
//
// Host code imports the plugin's modules ONLY through this barrel (one alias path:
// '@artlux/plugin-lidar-tracking'); the plugin's own files import each other relatively. This keeps
// a SINGLE module identity for every singleton (trackingStore, etc.): if host code deep-imported via
// the alias while internals imported relatively, the bundler would treat them as two modules and
// duplicate the singleton — the OSC tap / playback would write one store while the projector bridge
// reads an empty other. `sideEffects:false` (package.json) lets each window tree-shake the namespaces
// it doesn't use, so no cross-window bloat.

export * as trackingStore from './trackingStore';
export * as trackingRenderer from './trackingRenderer';
export * as trackingDrawable from './trackingDrawable';
export * as trackingPlayback from './trackingPlayback';
export * as trackingRecorder from './trackingRecorder';
export * as trackingTake from './trackingTake';
export * as blobMotion from './blobMotion';
export * as blobPass from './blobPass';
export * as blobClustering from './blobClustering';
export { clusterAndTrack, resetPeopleTracking } from './blobClustering';
// Trigger zones — the occupancy runtime + the zone-drawing panel. Exported through the barrel (never
// deep-imported) for the singleton reason at the top of this file: `zones` holds the latched
// occupancy the FSM triggers read, and a second copy of it would watch a store nobody writes.
export * as zones from './zones';
export { ZonePanel } from './ZonePanel';

export type { TrackingSnapshot, Blob, SurfaceTrack } from './trackingStore';
export type { BlobInst } from './blobPass';

// Plugin entry (registered by the host's activateRendererPlugins).
export { plugin } from './plugin.renderer';
