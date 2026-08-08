// Syphon plugin — renderer activation. Registers the Syphon content source (receive); the editor +
// discovery ride along on the provider (over the generic plugin IPC bridge).

import type { RendererPlugin, RendererPluginContext, ContentSourceProvider } from '@artlux/sdk/renderer';
import { syphonContentSource, reconcileSyphon } from './syphonContentSource';
import { setHost, subscribeSettings } from './syphonHost';

let unsubSettings: (() => void) | null = null;

export const plugin: RendererPlugin = {
  manifest: { id: 'syphon', name: 'Syphon', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setHost(ctx.host);
    ctx.contentSources.register(syphonContentSource as ContentSourceProvider);
    // The native receiver's poll rate follows AppSettings.engineFps, so a change to it has to reach
    // main. Nothing else does this for us: the provider only reconciles when a CONSUMER changes, and
    // editing a preference changes no consumer. reconcile() compares the rate and no-ops otherwise,
    // so the cost of an unrelated settings edit is one integer comparison.
    unsubSettings = subscribeSettings(reconcileSyphon);
  },

  deactivate(): void {
    unsubSettings?.();
    unsubSettings = null;
  },
};
