// MP4 plugin — renderer activation. Registers the WebCodecs MP4 codec into the video-codec registry.
// Renderer-only (WebCodecs + demux run in the renderer); no main process, no native addon.

import type { RendererPlugin, RendererPluginContext, VideoCodecContribution } from '@artlux/sdk/renderer';
import { mp4Codec } from './mp4Codec';

export const plugin: RendererPlugin = {
  manifest: { id: 'mp4', name: 'MP4 (WebCodecs)', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    ctx.videoCodecs.register(mp4Codec as VideoCodecContribution);
    // The "Video" Preferences section (the GPU-decode toggle) is the UI half's (ui.ts), so Preferences
    // shows it in any window.
  },

  // On the startup splash. The codec is REGISTERED here but stays inert until the mp4WebCodecs setting
  // is on (mp4Codec.canDecode returns false while off), and that setting arrives with the project —
  // after activation. So the honest boot line is "registered, opt-in", never "GPU decode active".
  status: () => ({ state: 'ok', detail: 'codec registered — opt-in via Video settings' }),
};
