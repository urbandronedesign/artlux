// @artlux/plugin-calibration/authoring — the AUTHORING barrel: everything that PRODUCES a calibration.
// The workbench and its three wizards, the session logic (pose pairing + solve), camera capture,
// structured light, the rig-blend scan store + solve + inspector, camera gamma, unattended
// recalibration. Ships in ArtLux Calibrator only once the suite has two build targets (Phase 3).
//
// LOADED ON DEMAND, never statically (suite plan Phases 1–2, plans/artlux-suite-show-calibrator.md):
// the only value import of this file is the dynamic `import()` in ./authoringLoader, so the bundler
// keeps it in its own `authoring-*.js` chunk that a plain launch and every projector window never
// fetch. Host code may `import type` from `@artlux/plugin-calibration/authoring`; for values it goes
// through the loader the playback barrel exports.
//
// ⚠ A STATIC import of any of these modules from playback or host code re-merges them into the shared
// chunk, silently — the app still works, it just pays for authoring everywhere again.
// `verify:invariants` checks the static graph; `verify:plugins` checks the built chunks.

export { CalibViewport } from './CalibViewport';
export { RecalPanel } from './RecalPanel';
export { BlendInspector } from './BlendInspector';
// ArtLux Calibrator's own panels (suite plan Phase 3, step 5 — the approved design's S1/S4/S5).
export { RigList } from './RigList';
export { RigStatus } from './RigStatus';
export { BlendPanel } from './BlendPanel';
export { SignoffPanel } from './SignoffPanel';
export { CalibInspector } from './CalibInspector';
export * as calibWorkspace from './calibWorkspace';
export * as autoRecal from './autoRecal';
export * as calibController from './calibController';
export * as slCapture from './slCapture';
export * as calibCapture from './calibCapture';
export * as blendController from './blendController';
// The rig's scan store — a session singleton the scans fill and the solve reads. Authoring: nothing
// but a scan or a solve ever has anything to put in it.
export * as blendStore from './blendStore';
export { measureGamma } from './gammaController';

// Types the host may name with `import type` (no runtime cost).
export type { BoardConfig } from './calibController';
export type { ColorFrame } from './calibCapture';
export type { Verdict, RejectReason } from './validateSolve';
export type { ResidualStats } from './residuals';
export type { DriftScore } from './driftScore';
export type * from './markerlessController';
