// NDI plugin — renderer activation. Registers the NDI content source (receive); the editor +
// discovery ride along on the provider. The send path is driven by host call sites via the generic
// plugin bridge (window.artlux.pluginSend), so it needs no renderer registration here.

import type { RendererPlugin, RendererPluginContext, ContentSourceProvider } from '@artlux/sdk/renderer';
import { ndiContentSource } from './ndiContentSource';

export const plugin: RendererPlugin = {
  manifest: { id: 'ndi', name: 'NDI', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    ctx.contentSources.register(ndiContentSource as ContentSourceProvider);
  },
};
