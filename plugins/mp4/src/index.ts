// @artlux/plugin-mp4 — renderer-only barrel (single alias path). Host code imports ONLY through here
// so `setEnabled` and the plugin share one module identity (the codec's clock/decoder singletons).

export { plugin } from './plugin.renderer';
export { setEnabled } from './mp4Codec';
