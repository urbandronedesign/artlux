// audio — main-process activation. Owns the native JUCE engine (via audioManager) and exposes it to
// the renderer over the generic plugin bridge:
//   renderer → main : audio:configure/getDevices/getMeters/loadClip (invoke, need a reply)
//                     audio:unloadClip/playClip/stopClip/setClipGain/stopAll (send, fire-and-forget)
// The engine graceful-degrades: if the .node is missing every handler is a harmless no-op.

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as engine from './audioManager';

export const plugin: MainPlugin = {
  manifest: { id: 'audio', name: 'Audio', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;

    // Reply channels (renderer invoke). configure/loadClip may throw in the addon → the invoke rejects.
    ipc.handle('audio:configure', (ch) => engine.configure(typeof ch === 'number' ? ch : 2));
    ipc.handle('audio:getDevices', () => engine.getDevices());
    ipc.handle('audio:getMeters', () => engine.getMeters());
    ipc.handle('audio:loadClip', (id, path) => engine.loadClip(String(id), String(path)));

    // Fire-and-forget control (renderer send).
    ipc.on('audio:unloadClip', (id) => engine.unloadClip(String(id)));
    ipc.on('audio:playClip', (id, seek, gain) => engine.playClip(String(id), Number(seek) || 0, gain == null ? 1 : Number(gain)));
    ipc.on('audio:stopClip', (id) => engine.stopClip(String(id)));
    ipc.on('audio:setClipGain', (id, gain) => engine.setClipGain(String(id), gain == null ? 1 : Number(gain)));
    ipc.on('audio:setClipSpatial', (id, x, y, z) => engine.setClipSpatial(String(id), Number(x) || 0, Number(y) || 0, Number(z) || 0));
    ipc.on('audio:clearClipSpatial', (id) => engine.clearClipSpatial(String(id)));
    ipc.on('audio:stopAll', () => engine.stopAll());
  },

  deactivate(): void {
    engine.close();
  },
};
