// The LiDAR tracking plugin's UI HALF (E5/W5). TRACKING content has nothing to set up in the content
// editor (its settings are the core OSC / Tracking preferences), and it says so by registering an entry
// WITHOUT an editor: a type with no entry at all tells a panel window "this is set up in the editor".
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';

export const ui: RendererPluginUi = {
  id: 'lidar-tracking',
  activateUi(ctx) {
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({ type: 'TRACKING' });
  },
};
