// HAP plugin — main-process activation. Owns the native HAP decoder and wires its IPC over the
// generic plugin bridge: open (probe → HapInfo), decode (frame by index), close.

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as hap from './hapManager';

export const plugin: MainPlugin = {
  manifest: { id: 'hap', name: 'HAP', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;
    ipc.handle('hap:open', (path) => hap.open(path as string));               // → HapInfo | null
    ipc.handle('hap:decode', (path, index) => hap.decode(path as string, index as number)); // → HapFrame | null
    ipc.on('hap:close', (path) => hap.close(path as string));
  },

  deactivate(): void { hap.closeAll(); },

  // Reported on the startup splash. Without the decoder a HAP .mov still plays — through <video>,
  // which cannot read HAP, so it plays as nothing. Worth seeing at startup.
  status: () => hap.available()
    ? { state: 'ok', detail: 'native decoder loaded' }
    : { state: 'degraded', detail: 'native decoder unavailable — HAP .movs will not play' },
};
