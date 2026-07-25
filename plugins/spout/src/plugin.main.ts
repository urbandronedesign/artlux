// Spout plugin — main-process activation. Owns the native Spout receiver and wires its IPC over the
// generic plugin bridge: list senders (request/response), configure (start/stop), frame push. Mirrors
// plugin-ndi's receive path; Spout is receive-only so there's no send half.

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as spout from './spoutManager';
import type { SpoutConfig } from './types';

export const plugin: MainPlugin = {
  manifest: { id: 'spout', name: 'Spout', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;
    ipc.handle('spout:list', () => spout.listSenders());
    ipc.on('spout:configure', (cfg) => {
      const c = cfg as SpoutConfig;
      if (c.enabled) spout.start(c.name ?? '', (frame) => ipc.send('spout:frame', frame));
      else spout.stop();
    });
  },

  deactivate(): void { spout.stop(); },

  // Reported on the startup splash. Spout is a Windows-only GPU-sharing API, so an absent receiver
  // off Windows is EXPECTED ('off'), not a broken install ('degraded') — the splash must not cry wolf
  // on a mac where Spout could never have worked.
  status: () => spout.available()
    ? { state: 'ok', detail: 'native receiver loaded' }
    : process.platform === 'win32'
      ? { state: 'degraded', detail: 'native receiver unavailable' }
      : { state: 'off', detail: 'Windows only' },
};
