// How the show-control plugin's UI half reaches its main half (E5/W5k): the IPC handle `activateUi` was
// given — the same bridge in every window, so the Preferences section asks main for the LAN addresses
// and a new PIN from a panel window exactly as from the editor.
import type { PluginIpc } from '@artlux/sdk/renderer';
let ipc: PluginIpc | null = null;
export function setIpc(i: PluginIpc): void { ipc = i; }
export function getIpc(): PluginIpc | null { return ipc; }
