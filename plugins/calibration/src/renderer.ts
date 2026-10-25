// @artlux/plugin-calibration/renderer — renderer barrel. Host code imports the calibration logic +
// the native wrapper ONLY through here (single module identity — see docs/PLUGINS.md). NEVER pull
// main/node code (calibManager). The `plugin` export (Stage 2 "foundation" slice) registers the
// projector→main back-channel tap; the wizard UIs are still host-side (Stage 2b).

// Plugin entry (registered by the host's activateRendererPlugins).
export { plugin } from './plugin.renderer';

// Wizard UIs + the pose-pairing orchestration, co-located here. App mounts the wizards (it owns the
// embedded Simulator3D + camera portal they drive) and forwards 3D picks into `calibWorkspace`, which
// owns the board/markerless pose logic (moved out of App, Stage 2d).
// CalibWizard / AutoAlignWizard are NO LONGER exported: they are mounted by this plugin's own
// `calibration.workbench` viewport panel, not by the host. App importing them was the Stage 2b seam.
export * as calibWorkspace from './calibWorkspace';

// Namespaces (host imports these as `import { X }` and uses X.member).
export * as calibNative from './calibNative';

// THE AUTHORING HALF (wizards, camera, structured light, the blend solve + inspector, gamma, unattended
// recalibration) is NOT re-exported here — re-exporting it would put it back in the shared chunk that
// every launch and every projector window evaluates (suite plan Phase 1). Host code reaches it on
// demand: `useCalibrationAuthoring(want)` in a component, `await loadCalibrationAuthoring()` in an action.
export {
  useAuthoring as useCalibrationAuthoring,
  loadAuthoring as loadCalibrationAuthoring,
  type Authoring as CalibrationAuthoring,
} from './authoringLoader';

// Flat named symbols the host imports directly.
export type { BoardConfig } from './calibController';
export { reproject, frustumCorners, cameraPose, cameraCenter, glProjectionMatrix } from './cvCamera';
export { fillPattern, type CalibPatternKind } from './graycode';
export type { BlendMap } from './blendCompute';
// The rig's scan store — a session singleton the blend solve (authoring) fills and RigBlendStrip reads.
// ONLY through this barrel, or blendStore becomes two singletons and the solve reads an empty one
// (docs/PLUGINS.md). The solve itself and the inspector come through the authoring loader.
export * as blendStore from './blendStore';
// The staleness rule alone — pure, so the strip can label a stale blend without loading the solve.
export { isStale as isBlendStale } from './blendStale';
export type { Verdict, RejectReason } from './validateSolve';
export type { ResidualStats } from './residuals';
export type { DriftScore } from './driftScore';
export { registerVenueMesh, unregisterVenueMesh } from './venueRaycast';
// Live projected mapping: turns a model's `uvProjFrom` (a calibrated output's surfaceId) into the
// matrix + eye the shared shader consumes. Called by App at the scene push and by Simulator3D — main
// holds every calibration, and a projector window holds only its own, so this cannot run there.
export { resolveProjectedScene } from './projectedScene';
export type { ColorFrame } from './calibCapture';
export type * from './markerlessController';
