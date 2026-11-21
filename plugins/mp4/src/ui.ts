// The MP4 plugin's UI HALF (E5/W5k): the "Video" Preferences section (the GPU-decode toggle), with
// nothing that runs — the codec is the runtime's (plugin.renderer.ts). Activated by the host in every
// window (host/pluginUi.ts), so Preferences in a panel window shows it too. The setting stays core.
import React from 'react';
import { Film } from 'lucide-react';
import type { RendererPluginUi, SettingsSection } from '@artlux/sdk/renderer';
import { VideoSettings } from './VideoSettings';

export const ui: RendererPluginUi = {
  id: 'mp4',
  activateUi(ctx) {
    ctx.settings.register({ id: 'video', title: 'Video', icon: React.createElement(Film, { size: 12 }), Component: VideoSettings } as unknown as SettingsSection);
  },
};
