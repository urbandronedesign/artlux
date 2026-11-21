// The Syphon plugin's UI HALF (E5/W5): the picker the content editor shows for a SYPHON surface, with
// nothing that runs. Activated by the host in the editor AND in a panel window (host/pluginUi.ts).
// Discovery is a question to main (syphonDiscovery.ts); the "cannot run here" verdict is the receiver's,
// published by the runtime and read through the live view (uiLink.ts).
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { SyphonEditor } from './SyphonEditor';
import { setLiveView } from './uiLink';

export const ui: RendererPluginUi = {
  id: 'syphon',
  activateUi(ctx) {
    setLiveView(ctx.live);
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({ type: 'SYPHON', editor: SyphonEditor as never });
  },
};
