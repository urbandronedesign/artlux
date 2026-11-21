// The Augmenta plugin's UI HALF (E5/W5): what the content editor shows for an AUGMENTA surface, with
// nothing that runs. Activated by the host in the editor AND in a panel window (host/pluginUi.ts),
// so it must reach no store, drawable or OSC code — the editor fragment reads only the content.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { AugmentaContentEditor } from './augmentaContentEditor';

export const ui: RendererPluginUi = {
  id: 'augmenta',
  activateUi(ctx) {
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'AUGMENTA',
      editor: AugmentaContentEditor as never,
      pickerButton: { label: 'Augmenta', title: 'Augmenta box optical tracking (OSC)' },
    });
  },
};
