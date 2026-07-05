// @artlux/plugin-show-control/main — main-process barrel. Single module identity for the embedded
// HTTP/SSE control server, the wall-clock scheduler, the project scanner + playlist store, and the
// metrics assembler. The host (main plugin activation) reaches these only through here; the plugin's
// own files import each other relatively. NEVER pull renderer/React code from this entry.

export { plugin } from './plugin.main';
