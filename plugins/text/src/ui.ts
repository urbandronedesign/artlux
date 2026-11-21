// The Text plugin's UI HALF (E5/W5): what the content editor shows for a TEXT surface, with nothing
// that runs. Activated by the host in the editor AND in a panel window (host/pluginUi.ts). The
// rasterizer stays out; an imported font's load state is the editor's, read through the live view.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { TextContentEditor } from './textContentEditor';
import { setLiveView } from './uiLink';

export const ui: RendererPluginUi = {
  id: 'text',
  activateUi(ctx) {
    setLiveView(ctx.live);
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'TEXT',
      editor: TextContentEditor as never,
      pickerButton: { label: 'Text', title: 'Typed copy on this surface' },
    });
  },
};
