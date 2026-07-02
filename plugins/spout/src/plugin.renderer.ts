// Spout plugin — renderer activation. Registers the Spout content source (receive); the editor +
// discovery ride along on the provider (over the generic plugin IPC bridge).

import type { RendererPlugin, RendererPluginContext, ContentSourceProvider } from '@artlux/sdk/renderer';
import { spoutContentSource } from './spoutContentSource';

export const plugin: RendererPlugin = {
  manifest: { id: 'spout', name: 'Spout', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    ctx.contentSources.register(spoutContentSource as ContentSourceProvider);
  },
};
