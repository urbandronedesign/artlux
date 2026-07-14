// Barrel — main-process entry (host imports the plugin only via this barrel; internal files import
// each other relatively; "sideEffects": false — the singleton-safety contract, see CLAUDE.md).
export { plugin } from './plugin.main';
