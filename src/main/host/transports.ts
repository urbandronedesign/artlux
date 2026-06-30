// Host-side main-process transport registry.
//
// A plugin's main entry registers an input transport (e.g. a UDP/OSC LiDAR feed). On register the
// host immediately installs the IPC plumbing: the renderer configures the transport over
// 'plugin:<configureChannel>', and each decoded batch is pushed to the renderer over
// 'plugin:<messageChannel>'. Delivery stays array-batched (the transport pushes one array per
// source packet) so a 61fps firehose never floods IPC.
//
// Mirrors the concrete contract in `@artlux/sdk/main`. Built on `ipcMain` + a window accessor.

import { ipcMain, type BrowserWindow } from 'electron';
import type { MainTransport, MainTransportRegistry } from '@artlux/sdk/main';

export function createMainTransportHost(getWindow: () => BrowserWindow | null): MainTransportRegistry {
  const registered = new Set<string>();
  return {
    register(t: MainTransport): void {
      if (registered.has(t.id)) return;
      registered.add(t.id);
      const push = (messages: Parameters<Parameters<MainTransport['start']>[1]>[0]) =>
        getWindow()?.webContents.send('plugin:' + t.messageChannel, messages);
      ipcMain.on('plugin:' + t.configureChannel, (_e, config: unknown) => {
        try { t.start(config, push); } catch (e) { console.error(`[plugin:${t.id}] transport start failed`, e); }
      });
    },
  };
}
