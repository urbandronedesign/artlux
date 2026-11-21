// The NDI plugin's UI HALF (E5/W5): the source picker the content editor shows for an NDI surface, with
// nothing that runs. Activated by the host in the editor AND in a panel window (host/pluginUi.ts).
// Discovery is a question to main (ndiDiscovery.ts), so it is the same answer from any window; the
// receiver — the one thing that holds a stream — is not reachable from here.
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { NdiEditor } from './NdiEditor';

export const ui: RendererPluginUi = {
  id: 'ndi',
  activateUi(ctx) {
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({ type: 'NDI', editor: NdiEditor as never });
  },
};
