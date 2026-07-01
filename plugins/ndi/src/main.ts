// @artlux/plugin-ndi/main — main-process barrel. Single module identity for the native manager:
// the host (main/index.ts lifecycle) and the plugin entry both reach ndiManager through here +
// relative imports, so there's never a duplicate native load / sender set. NEVER pull renderer code.

export * as ndiManager from './ndiManager';
export { plugin } from './plugin.main';
