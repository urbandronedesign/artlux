// Spout plugin — renderer activation. Registers the Spout content source (receive); the editor +
// discovery ride along on the provider (over the generic plugin IPC bridge).

import type { RendererPlugin, RendererPluginContext, ContentSourceProvider } from '@artlux/sdk/renderer';
import { spoutContentSource, reconcileSpout } from './spoutContentSource';
import { setHost, subscribeSettings } from './spoutHost';
import { spoutIncompatibility, onSpoutStatus } from './spoutReceiver';

let unsubSettings: (() => void) | null = null;

export const plugin: RendererPlugin = {
  manifest: { id: 'spout', name: 'Spout', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setHost(ctx.host);
    ctx.contentSources.register(spoutContentSource as ContentSourceProvider);
    // What the picker shows when Spout cannot run here: the receiver's verdict, for the UI half in any
    // window (ui.ts reads it through the live view). Only the receiver learns it, so only it publishes.
    ctx.live.stream('spout.status', { watch: onSpoutStatus, read: () => spoutIncompatibility() });
    // The native receiver's poll rate follows AppSettings.engineFps, so a change to it has to reach
    // main. Nothing else does this for us: the provider only reconciles when a CONSUMER changes, and
    // editing a preference changes no consumer. reconcile() compares the rate and no-ops otherwise,
    // so the cost of an unrelated settings edit is one integer comparison.
    unsubSettings = subscribeSettings(reconcileSpout);
  },

  deactivate(): void {
    unsubSettings?.();
    unsubSettings = null;
  },
};
