// Host-side first-party plugin activation (renderer).
//
// In-tree plugins are statically imported (no dynamic disk loading). This module builds the plugin
// context from the host registries + service handles and activates each registered renderer plugin
// once per window. App (main window) calls activateRendererPlugins('main', {...}); each projector
// window calls activateRendererPlugins('projector') so projector-channel `apply()` runs there too.

import {
  contentSourceRegistry, clipKindRegistry, projectorChannelRegistry,
  settingsSectionRegistry, panelRegistry, sceneVizRegistry, projectorPanelRegistry,
} from './registries';
import { timeline } from '../services/timeline';
import type { RendererPlugin, RendererPluginContext, PluginIpc, RendererHostServices } from '@artlux/sdk/renderer';
import { plugin as lidarTracking } from '@artlux/plugin-lidar-tracking';
import { plugin as ndi } from '@artlux/plugin-ndi/renderer';
import { plugin as calibration } from '@artlux/plugin-calibration/renderer';

const FIRST_PARTY: RendererPlugin[] = [lidarTracking, ndi, calibration];

let activated = false;

// Projector windows (and any caller that doesn't own editor state) get inert host services: reads
// return empty, patches/sends are dropped, and projector→main onMessage never fires (only the main
// window owns the bridge ports). The main window (App) injects the real implementations.
const NOOP_HOST: RendererHostServices = {
  projectorOutputs: { get: () => undefined, list: () => [], patch: () => {}, subscribe: () => () => {} },
  scene3D: { get: () => ({}), patch: () => {}, subscribe: () => () => {} },
  projectors: { send: () => {}, onMessage: () => () => {} },
};

function makeContext(win: 'main' | 'projector', host: RendererHostServices): RendererPluginContext {
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
    sceneViz: sceneVizRegistry,
    projectorPanels: projectorPanelRegistry,
    ipc,
    onPlayhead: (cb) => timeline.subscribe(cb),
    host,
  } as unknown as RendererPluginContext;
}

export function activateRendererPlugins(win: 'main' | 'projector', host: RendererHostServices = NOOP_HOST): void {
  if (activated) return;
  activated = true;
  const ctx = makeContext(win, host);
  for (const p of FIRST_PARTY) {
    try { p.activate(ctx); } catch (e) { console.error(`[plugins] ${p.manifest.id} activate failed`, e); }
  }
}
