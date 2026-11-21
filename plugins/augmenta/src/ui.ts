// The Augmenta plugin's UI HALF (E5/W5): what the content editor shows for an AUGMENTA surface, and the
// Augmenta Monitor, with nothing that runs. Activated by the host in the editor AND in a panel window
// (host/pluginUi.ts), so it must reach no store or drawable: the editor fragment reads only the
// content, and the monitor taps the OSC wire itself and reads settings through the UI host (uiLink.ts).
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { AugmentaContentEditor } from './augmentaContentEditor';
import { AugmentaMonitor } from './AugmentaMonitor';
import { setUiHost } from './uiLink';

export const ui: RendererPluginUi = {
  id: 'augmenta',
  activateUi(ctx) {
    setUiHost(ctx.host);
    ctx.panels.register({ id: 'augmenta-monitor', mount: 'dock', detachable: true, menuAction: 'augmenta-monitor', title: 'Augmenta Monitor', Component: AugmentaMonitor });
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({
      type: 'AUGMENTA',
      editor: AugmentaContentEditor as never,
      pickerButton: { label: 'Augmenta', title: 'Augmenta box optical tracking (OSC)' },
    });
  },
};
