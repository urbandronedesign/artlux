// @artlux/plugin-calibration/renderer — renderer barrel. Host code imports the calibration logic +
// the native wrapper ONLY through here (single module identity — see docs/PLUGINS.md). NEVER pull
// main/node code (calibManager). Stage 1 has no renderer registry contribution, so there is no
// `plugin` export / renderer activation yet (wizards + panels are Stage 2).

// Namespaces (host imports these as `import { X }` and uses X.member).
export * as calibController from './calibController';
export * as slCapture from './slCapture';
export * as calibCapture from './calibCapture';
export * as calibNative from './calibNative';

// Flat named symbols the host imports directly.
export { defaultBoardConfig, type BoardConfig } from './calibController';
export { measureGamma } from './gammaController';
export { reproject, frustumCorners, cameraPose, glProjectionMatrix } from './cvCamera';
export { fillPattern, type CalibPatternKind } from './graycode';
export type { BlendMap } from './blendCompute';
export { regionFromCalibration } from './mpcdiData';
export { registerVenueMesh, unregisterVenueMesh } from './venueRaycast';
export type { ColorFrame } from './calibCapture';
export * from './markerlessController';
