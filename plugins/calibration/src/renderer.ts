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
export * as calibController from './calibController';
export * as slCapture from './slCapture';
export * as calibCapture from './calibCapture';
export * as calibNative from './calibNative';

// Flat named symbols the host imports directly.
export { defaultBoardConfig, type BoardConfig } from './calibController';
export { measureGamma } from './gammaController';
export { reproject, frustumCorners, cameraPose, cameraCenter, glProjectionMatrix } from './cvCamera';
export { fillPattern, type CalibPatternKind } from './graycode';
export type { BlendMap } from './blendCompute';
// The rig blend: capture/solve/apply + the staleness rule. Host UI (OutputsPanel) drives this — as
// always, ONLY through this barrel, or blendStore becomes two singletons and the solve reads an
// empty one (docs/PLUGINS.md).
export * as blendController from './blendController';
export * as blendStore from './blendStore';
export { BlendInspector } from './BlendInspector';
// Unattended recalibration: the orchestrator, its policy gate and the pure drift scoring.
export * as autoRecal from './autoRecal';
export { validateSolve, type Verdict, type RejectReason } from './validateSolve';
export { computeResiduals, type ResidualStats } from './residuals';
export type { DriftScore } from './driftScore';
export { regionFromCalibration } from './mpcdiData';
export { registerVenueMesh, unregisterVenueMesh } from './venueRaycast';
export type { ColorFrame } from './calibCapture';
export * from './markerlessController';
