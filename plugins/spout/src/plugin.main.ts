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
      // Spout is GPU-only: the texture is the delivery, and there is no pixel path behind it. Wiring
      // the sink to null when this Electron has no sharedTexture is what makes start() report
      // 'no-shared-texture' rather than silently doing nothing.
      spout.setSharedSink(
        gpu.available() ? (s) => gpu.deliver(ctx.window() as BrowserWindow | null, s) : null,
        (why) => ipc.send('spout:incompatible', why),
      );
      // `fps` only sets the poll FLOOR (see pollHz) — the poll follows the sender, not the engine.
      if (c.enabled) spout.start(c.name ?? '', c.fps);
      else spout.stop();
    });
  },

  deactivate(): void { spout.stop(); },

  // Reported on the startup splash. Spout is a Windows-only GPU-sharing API, so an absent receiver
  // off Windows is EXPECTED ('off'), not a broken install ('degraded') — the splash must not cry wolf
  // on a mac where Spout could never have worked.
  status: () => {
    if (!spout.available()) {
      return process.platform === 'win32'
        ? { state: 'degraded', detail: 'native receiver unavailable' }
        : { state: 'off', detail: 'Windows only' };
    }
    // GPU texture sharing is not an optimisation here, it is the whole feature — so an Electron
    // without it makes Spout unusable, and the splash must say that rather than showing a healthy
    // plugin that will never produce a picture.
    if (!gpu.available()) return { state: 'degraded', detail: 'no GPU texture sharing — Spout unavailable' };
    const why = spout.incompatibility();
    return why
      ? { state: 'degraded', detail: `unavailable: ${why}` }
      : { state: 'ok', detail: 'native receiver loaded, GPU texture sharing' };
  },
};
