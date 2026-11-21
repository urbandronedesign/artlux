// The show-control plugin's UI HALF (E5/W5k): the "Show Control" Preferences section, with nothing that
// runs — the server, the scheduler and the tablet bridge are the runtime's and main's. The section reads
// settings it is handed and talks to main through ctx.ipc (uiLink.ts), so it works in any window.
import type { RendererPluginUi, SettingsSection } from '@artlux/sdk/renderer';
import { ShowControlSettings } from './ShowControlSettings';
import { setIpc } from './uiLink';

export const ui: RendererPluginUi = {
  id: 'show-control',
  activateUi(ctx) {
    setIpc(ctx.ipc);
    ctx.settings.register({ id: 'show-control', title: 'Show Control', Component: ShowControlSettings } as unknown as SettingsSection);
  },
};
