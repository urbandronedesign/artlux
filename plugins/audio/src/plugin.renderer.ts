// audio — renderer activation. Registers the Audio settings section (Preferences) in every window,
// and — in the main window only — configures the native engine from the persisted output-channel
// count on startup. The playhead-driven bed player + the audio clip-kind land in a later phase.

import type { RendererPlugin, RendererPluginContext, RendererHostServices } from '@artlux/sdk/renderer';
import { setIpc } from './audioClient';
import { AudioSettings } from './AudioSettings';

interface AudioPluginCfg { outputChannels?: number }

export const plugin: RendererPlugin = {
  manifest: { id: 'audio', name: 'Audio', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setIpc(ctx.ipc);
    ctx.settings.register({ id: 'audio', title: 'Audio', Component: AudioSettings });

    // Only the main editor/broadcast window drives the engine.
    if (ctx.window !== 'main') return;

    const host = ctx.host as RendererHostServices;
    const s = host.settings.get() as { plugins?: Record<string, unknown> };
    const cfg = (s.plugins?.['audio'] as AudioPluginCfg) ?? {};
    // Open the device once on startup (default device, persisted channel count). Reconfiguring on
    // every settings change would re-init the device (a glitch), so that's driven explicitly from
    // the settings UI instead.
    void ctx.ipc.invoke('audio:configure', cfg.outputChannels ?? 2).catch(() => { /* engine absent → no-op */ });
  },
};
