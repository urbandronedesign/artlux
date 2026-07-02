// MP4 plugin — renderer activation. Registers the WebCodecs MP4 codec into the video-codec registry.
// Renderer-only (WebCodecs + demux run in the renderer); no main process, no native addon.

import type { RendererPlugin, RendererPluginContext, VideoCodecContribution } from '@artlux/sdk/renderer';
import { mp4Codec } from './mp4Codec';

export const plugin: RendererPlugin = {
  manifest: { id: 'mp4', name: 'MP4 (WebCodecs)', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    ctx.videoCodecs.register(mp4Codec as VideoCodecContribution);
  },
};
