// @artlux/plugin-syphon/main — main-process barrel. Single module identity for the native manager:
// anything host-side that needs syphonManager reaches it through here + relative imports, so there
// is never a duplicate native load. NEVER pull renderer code.

export * as syphonManager from './syphonManager';
export { plugin } from './plugin.main';
