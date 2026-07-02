// Host-side first-party plugin activation (main process).
//
// Builds the main plugin context (a generic IPC handle namespaced under 'plugin:<ch>' and bound to
// the active window) and activates each registered main plugin once. Called from registerIpc.

import { ipcMain, type BrowserWindow } from 'electron';
import type { MainPlugin, MainPluginContext, MainPluginIpc } from '@artlux/sdk/main';
import { plugin as ndi } from '@artlux/plugin-ndi/main';
import { plugin as calibration } from '@artlux/plugin-calibration/main';
import { plugin as spout } from '@artlux/plugin-spout/main';

const FIRST_PARTY: MainPlugin[] = [ndi, calibration, spout];

let activated = false;

function makeContext(getWindow: () => BrowserWindow | null): MainPluginContext {
  const ipc: MainPluginIpc = {
    handle(channel, handler) { ipcMain.handle('plugin:' + channel, (_e, ...args) => handler(...args)); },
    on(channel, handler) { ipcMain.on('plugin:' + channel, (_e, ...args) => handler(...args)); },
    send(channel, ...args) { getWindow()?.webContents.send('plugin:' + channel, ...args); },
  };
  return { ipc };
}

export function activateMainPlugins(getWindow: () => BrowserWindow | null): void {
  if (activated) return;
  activated = true;
  const ctx = makeContext(getWindow);
  for (const p of FIRST_PARTY) {
    try { p.activate(ctx); } catch (e) { console.error(`[plugins:main] ${p.manifest.id} activate failed`, e); }
  }
}
