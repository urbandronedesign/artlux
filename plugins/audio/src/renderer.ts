// Barrel — renderer-process entry (see main.ts for the barrel/singleton contract).
export { plugin } from './plugin.renderer';

// NON-REALTIME RENDERING, for anything that renders the show off the wall clock (plugins/bake).
// Exported THROUGH THE BARREL on purpose: a consumer reaching into plugins/audio/src/audioClient
// directly would get a second copy of the module, and the copy holding the ipc handle would not be
// the copy being called. That is the single-identity rule this repo has already paid for once.
export { offlineBegin, offlinePull, offlineEnd } from './audioClient';
