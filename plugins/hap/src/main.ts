// @artlux/plugin-hap/main — main-process barrel. Single module identity for the native decoder (the
// plugin entry reaches hapManager relatively; the barrel exists for consistency + any future host
// lifecycle hook). NEVER pull renderer code.

export * as hapManager from './hapManager';
export { plugin } from './plugin.main';
