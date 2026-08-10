// @artlux/plugin-shader/main — main-process barrel.
//
// Single module identity for the library store, and a hard wall against the renderer half: this file
// must NEVER pull renderer code, because that half imports WebGL, React and CodeMirror and none of it
// can exist in main. The two barrels are what keep that mistake impossible to make by accident.

export * as libraryStore from './libraryStore';
export type { LibraryEntry } from './libraryStore';
export { plugin } from './plugin.main';
