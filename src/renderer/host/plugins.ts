// Host-side first-party plugin activation (renderer).
//
// In-tree plugins are statically imported (no dynamic disk loading). This module builds the plugin
// context from the host registries + service handles and activates each registered renderer plugin
// once per window. App (main window) calls activateRendererPlugins('main'); the projector window
// doesn't use the renderer registries today, so it isn't activated.

import {
  contentSourceRegistry, clipKindRegistry, projectorChannelRegistry,
  settingsSectionRegistry, panelRegistry,
} from './registries';
import { timeline } from '../services/timeline';
import type { RendererPlugin, RendererPluginContext, PluginIpc } from '@artlux/sdk/renderer';
import { plugin as lidarTracking } from '@artlux/plugin-lidar-tracking';
import { plugin as ndi } from '@artlux/plugin-ndi/renderer';

const FIRST_PARTY: RendererPlugin[] = [lidarTracking, ndi];

let activated = false;

function makeContext(win: 'main' | 'projector'): RendererPluginContext {
  const ipc: PluginIpc = {
    invoke: (ch, ...a) => window.artlux!.pluginInvoke(ch, ...a),
    send: (ch, ...a) => window.artlux!.pluginSend(ch, ...a),
    on: (ch, cb) => window.artlux!.pluginOn(ch, cb),
  };
  // The host registries are concretely typed; the SDK context is generic (unknown). Cast at this
  // single boundary rather than threading host domain types through the SDK.
  return {
    window: win,
    contentSources: contentSourceRegistry,
    clipKinds: clipKindRegistry,
    projectorChannels: projectorChannelRegistry,
    settings: settingsSectionRegistry,
    panels: panelRegistry,
    ipc,
    onPlayhead: (cb) => timeline.subscribe(cb),
  } as unknown as RendererPluginContext;
}

export function activateRendererPlugins(win: 'main' | 'projector'): void {
  if (activated) return;
  activated = true;
  const ctx = makeContext(win);
  for (const p of FIRST_PARTY) {
    try { p.activate(ctx); } catch (e) { console.error(`[plugins] ${p.manifest.id} activate failed`, e); }
  }
}
