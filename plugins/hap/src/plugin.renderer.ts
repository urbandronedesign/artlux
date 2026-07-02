// HAP plugin — renderer activation. Registers the HAP video codec; the host dispatches .mov content
// (surfaces + timeline layers + thumbnails) through the codec registry.

import type { RendererPlugin, RendererPluginContext, VideoCodecContribution } from '@artlux/sdk/renderer';
import { hapCodec } from './hapCodec';

export const plugin: RendererPlugin = {
  manifest: { id: 'hap', name: 'HAP', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    ctx.videoCodecs.register(hapCodec as VideoCodecContribution);
  },
};
