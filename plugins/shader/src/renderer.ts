// @artlux/plugin-shader/renderer — renderer barrel.
//
// Host code imports this plugin ONLY through this barrel ('@artlux/plugin-shader'); the plugin's own
// files import each other relatively. That is not style: mixing the package alias with relative
// imports makes the bundler treat them as two modules and DUPLICATES every singleton — and this
// plugin's central singleton is the one WebGL2 context. Two of those is precisely the failure the
// context is there to prevent (a browser caps live contexts and drops the oldest silently).
//
// `sideEffects: false` in package.json lets each window tree-shake what it does not use.

export * as shaderContext from './shaderContext';
export * as shaderDrawable from './shaderDrawable';
export * as starters from './starters';
export * as wrapper from './wrapper';
export * as shaderGuard from './shaderGuard';
export * as header from './header';
export * as shaderParams from './shaderParams';
export * as shaderSource from './shaderSource';
export * as libraryClient from './libraryClient';

export type { Starter } from './starters';

// Plugin entry (registered by the host's activateRendererPlugins).
export { plugin } from './plugin.renderer';
