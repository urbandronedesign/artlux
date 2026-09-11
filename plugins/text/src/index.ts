// Text plugin — public barrel.
//
// Host code imports this plugin's modules ONLY through this barrel ('@artlux/plugin-text'); the
// plugin's own files import each other relatively. That keeps a SINGLE module identity for the
// raster cache: deep-importing via the alias while internals import relatively makes the bundler
// treat them as two modules and duplicates the singleton — the projector window would then render
// into one cache while the generation counter was read from an empty other. `sideEffects: false`
// (package.json) lets each window tree-shake what it does not use.

export * as textRaster from './textRaster';
export { TextContentEditor } from './textContentEditor';
export { plugin } from './plugin.renderer';
