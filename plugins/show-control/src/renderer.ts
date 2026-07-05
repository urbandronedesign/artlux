// @artlux/plugin-show-control/renderer — renderer-process barrel. NEVER pull main/node code
// (server / scheduler / fs). The renderer half owns the command dispatch into cueBus/timeline, the
// snapshot/status push up to main, the Preferences settings section, and the operator panel.

export { plugin } from './plugin.renderer';
