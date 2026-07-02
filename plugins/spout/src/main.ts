// @artlux/plugin-spout/main — main-process barrel. Single module identity for the native manager:
// the host (main/index.ts broadcast cap) and the plugin entry both reach spoutManager through here +
// relative imports, so there's never a duplicate native load. NEVER pull renderer code.

export * as spoutManager from './spoutManager';
export { plugin } from './plugin.main';
