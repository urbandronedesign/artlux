// @artlux/plugin-show-control/renderer — renderer-process barrel. NEVER pull main/node code
// (server / scheduler / fs). The renderer half owns the command dispatch into cueBus/timeline, the
// snapshot/status push up to main, the Preferences settings section, and the operator panel.

export { plugin } from './plugin.renderer';

// The open command seam: a plugin that owns a non-show ShowCommand kind registers here and inherits
// the scheduler + the tablet for free. Barrel-only, as always — commandExt holds a module-level Map,
// and a relative import from another plugin would give it a second, permanently empty one.
export { registerCommandHandler, hasCommandHandler } from './commandExt';
export type { ShowCommand } from './types';
