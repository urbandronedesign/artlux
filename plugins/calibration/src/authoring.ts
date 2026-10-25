// The AUTHORING half of the calibration plugin — everything that PRODUCES a calibration: the
// workbench and its three wizards, camera capture, structured light, the pose solves, the rig-blend
// solve and its inspector, camera gamma, and unattended recalibration.
//
// Reached ONLY through `authoringLoader` (a dynamic import), never statically — that is the point of
// this file (suite plan Phase 1, plans/artlux-suite-show-calibrator.md). A plain editor launch, and a
// projector window, then never parse or evaluate it: the bundler splits it into its own chunk, and
// nothing loads that chunk until an authoring panel mounts or an authoring command runs.
//
// ⚠ A STATIC import of any of these modules from playback code or from the host re-merges them into
// the shared chunk, silently — the app still works, it just pays for authoring everywhere again.
// `verify:invariants` checks that this file is the only door, and the built-chunk marker test in the
// plan's §8b checks the result.

export { CalibViewport } from './CalibViewport';
export { RecalPanel } from './RecalPanel';
export { BlendInspector } from './BlendInspector';
export * as autoRecal from './autoRecal';
export * as calibController from './calibController';
export * as slCapture from './slCapture';
export * as calibCapture from './calibCapture';
export * as blendController from './blendController';
export { measureGamma } from './gammaController';
