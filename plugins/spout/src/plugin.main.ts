// Spout plugin — main-process activation. Owns the native Spout receiver and wires its IPC over the
// generic plugin bridge: list senders (request/response), configure (start/stop), frame push. Mirrors
// plugin-ndi's receive path; Spout is receive-only so there's no send half.

import { app, type BrowserWindow } from 'electron';
import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as spout from './spoutManager';
import * as gpu from './sharedTexture.main';
import type { SpoutConfig } from './types';

export const plugin: MainPlugin = {
  manifest: { id: 'spout', name: 'Spout', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;
    // Stop polling before the window goes. Otherwise the poll keeps producing frames into a render
    // frame that is being disposed, and every one of them logs an Electron error on the way out.
    app.on('before-quit', () => spout.stop());
    ipc.handle('spout:list', () => spout.listSenders());
    ipc.on('spout:configure', (cfg) => {
      const c = cfg as SpoutConfig;
      // The GPU path, when this Electron can do it and the renderer asked for it. The sink returns
      // false on an import failure, which latches this connection back to the CPU path.
      spout.setSharedSink(
        (s) => gpu.deliver(ctx.window() as BrowserWindow | null, s),
        gpu.available() && c.gpu !== false,
      );
      // `fps` is the renderer's engine rate — how often anything actually consumes a frame. Re-sent
      // whenever it changes; start() re-arms the poll without reconnecting when only the rate moved.
      if (c.enabled) spout.start(c.name ?? '', c.fps, (frame) => ipc.send('spout:frame', frame));
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
