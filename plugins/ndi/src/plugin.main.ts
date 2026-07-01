// NDI plugin — main-process activation. Owns the native NDI addon and wires its IPC over the
// generic plugin bridge: receive (discovery + configure + frame push) and send (per-output).

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as ndi from './ndiManager';
import type { NdiConfig, NdiSendConfig } from './types';

export const plugin: MainPlugin = {
  manifest: { id: 'ndi', name: 'NDI', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;

    // Receive: discovery (request/response), configure (start/stop), frame push to the renderer.
    ipc.handle('ndi:available', () => ndi.available());
    ipc.handle('ndi:list', () => ndi.listSources());
    ipc.on('ndi:configure', (cfg) => {
      const c = cfg as NdiConfig;
      if (c.enabled) ndi.startRecv(c.name ?? '', (frame) => ipc.send('ndi:frame', frame));
      else ndi.stopRecv();
    });

    // Send: one named NDI source per projector output (binary frames over the generic bridge).
    ipc.on('ndi:send-configure', (cfg) => {
      const c = cfg as NdiSendConfig;
      ndi.sendConfigure(c.outputId, c.enabled, c.name ?? 'ArtLux');
    });
    ipc.on('ndi:send-frame', (outputId, width, height, data) => {
      ndi.sendFrame(outputId as string, width as number, height as number, Buffer.from(data as ArrayBuffer));
    });
  },

  deactivate(): void { ndi.stopAllSenders(); ndi.stopRecv(); },
};
