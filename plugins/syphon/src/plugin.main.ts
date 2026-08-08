// Syphon plugin — main-process activation. Owns the native Syphon receiver and wires its IPC over
// the generic plugin bridge: list servers (request/response), configure (start/stop), frame push.
// Mirrors plugin-spout; Syphon receive-only, so there is no send half (see the plan for why a
// SyphonMetalServer output is a separate feature).

import { app, type BrowserWindow } from 'electron';
import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as syphon from './syphonManager';
import * as gpu from './sharedTexture.main';
import type { SyphonConfig } from './types';

export const plugin: MainPlugin = {
  manifest: { id: 'syphon', name: 'Syphon', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;
    // Stop polling before the window goes. Otherwise the poll keeps producing frames into a render
    // frame that is being disposed, and every one of them logs an Electron error on the way out.
    app.on('before-quit', () => syphon.stop());
    ipc.handle('syphon:list', () => syphon.listServers());
    ipc.on('syphon:configure', (cfg) => {
      const c = cfg as SyphonConfig;
      // Syphon is GPU-only: the texture is the delivery, and there is no pixel path behind it.
      // Wiring the sink to null when this Electron has no sharedTexture is what makes start()
      // report 'no-shared-texture' rather than silently doing nothing.
      syphon.setSharedSink(
        gpu.available() ? (s) => gpu.deliver(ctx.window() as BrowserWindow | null, s) : null,
        (why) => ipc.send('syphon:incompatible', why),
      );
      // `fps` only sets the poll FLOOR — the poll follows the server, not the engine.
      if (c.enabled) syphon.start(c.name ?? '', c.appName ?? '', c.fps);
      else syphon.stop();
    });
  },

  deactivate(): void { syphon.stop(); },

  // Reported on the startup splash. Syphon is a macOS-only API, so an absent receiver off darwin is
  // EXPECTED ('off'), not a broken install ('degraded') — the splash must not cry wolf on a Windows
  // machine where Syphon could never have worked. The mirror of plugin-spout's Windows check.
  status: () => {
    if (!syphon.available()) {
      return process.platform === 'darwin'
        ? { state: 'degraded', detail: 'native receiver unavailable' }
        : { state: 'off', detail: 'macOS only' };
    }
    // GPU texture sharing is not an optimisation here, it is the whole feature — so an Electron
    // without it makes Syphon unusable, and the splash must say that rather than showing a healthy
    // plugin that will never produce a picture.
    if (!gpu.available()) return { state: 'degraded', detail: 'no GPU texture sharing — Syphon unavailable' };
    const why = syphon.incompatibility();
    return why
      ? { state: 'degraded', detail: `unavailable: ${why}` }
      : { state: 'ok', detail: 'native receiver loaded, GPU texture sharing' };
  },
};
