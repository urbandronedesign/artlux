// @artlux/plugin-calibration/playback — the PLAYBACK barrel (suite plan Phase 2,
// plans/artlux-suite-show-calibrator.md). Everything here ships in BOTH apps: it plays a calibration —
// live render-from-projector, a calibration file, the projected mapping in the 3D view — and lets the
// host read a calibration session's state. It produces none.
//
// The other half is `@artlux/plugin-calibration/authoring` (./authoring): the wizards, camera, structured
// light, the pose and blend solves, gamma, unattended recalibration. Host code NEVER imports it
// statically — only `import type`, or through the loader exported below — or the bundler merges it back
// into the chunk every launch and every projector window evaluates. `verify:invariants` walks the static
// import graph from this file and fails if it reaches an authoring module.
//
// Barrel rule (docs/PLUGINS.md): the host imports this plugin ONLY through its barrels; the plugin's own
// files import each other relatively. Mixing the two duplicates singletons. NEVER pull main/node code.

// Plugin entry (registered by the host's activateRendererPlugins).
export { plugin } from './plugin.renderer';

// The door to the authoring half: `useCalibrationAuthoring(want)` in a component, `await
// loadCalibrationAuthoring()` in an action, `loadedCalibrationAuthoring()` where a session is already
// open (a 3D pick during a pose capture) and loading would be wrong.
export {
  useAuthoring as useCalibrationAuthoring,
  loadAuthoring as loadCalibrationAuthoring,
  loadedAuthoring as loadedCalibrationAuthoring,
  type Authoring as CalibrationAuthoring,
} from './authoringLoader';

// The calibration session's STATE (which output, the flow, 3D pick mode, anchors) — read by App every
// render; written only by the authoring half, so it stays idle without a session.
export * as calibSession from './calibSession';

// Projector maths the host's 3D view draws with (frustums, the look-through camera).
export { reproject, frustumCorners, cameraPose, cameraCenter, glProjectionMatrix } from './cvCamera';
export type { BlendMap } from './blendCompute';
// The staleness rule alone — pure, so the outputs panel can label a stale blend without the solve.
export { isStale as isBlendStale } from './blendStale';
// Venue meshes for the raycaster. The host's 3D view registers what it loads.
export { registerVenueMesh, unregisterVenueMesh } from './venueRaycast';
// Live projected mapping: turns a model's `uvProjFrom` (a calibrated output's surfaceId) into the
// matrix + eye the shared shader consumes. Called by App at the scene push and by Simulator3D — main
// holds every calibration, and a projector window holds only its own, so this cannot run there.
export { resolveProjectedScene } from './projectedScene';
