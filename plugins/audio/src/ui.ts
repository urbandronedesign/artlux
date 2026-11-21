// The audio plugin's UI HALF (E5/W5k): the "Audio" Preferences section — device, layout, test tones —
// with nothing that runs here. The engine is JUCE in MAIN, one process for every window, so the section
// talks to it the same way from the editor or from a Preferences panel window (audioClient over ctx.ipc).
import type { RendererPluginUi, SettingsSection } from '@artlux/sdk/renderer';
import { AudioSettings } from './AudioSettings';
import { setIpc } from './audioClient';

export const ui: RendererPluginUi = {
  id: 'audio',
  activateUi(ctx) {
    setIpc(ctx.ipc);
    ctx.settings.register({ id: 'audio', title: 'Audio', Component: AudioSettings } as unknown as SettingsSection);
  },
};
