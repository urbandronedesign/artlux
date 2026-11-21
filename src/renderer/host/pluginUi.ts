// Plugin UI halves (E5/W5) — the contributions that only draw, activated in every window that shows them.
//
// A plugin's runtime (host/plugins.ts) starts receivers, engines and drawables, so a panel window must
// never activate it: that window would run a second, idle copy of each — a receiver with nobody to
// feed, or worse, one that grabs a device the editor holds. What a panel window DOES need from a plugin
// is its UI: the settings fragment the content editor shows for that plugin's source type. That lives
// in the plugin's `/ui` entry, which imports nothing that runs; this module is the one list of them.
//
// THE EDITOR ACTIVATES THE SAME LIST (activateRendererPlugins calls this first), so a UI contribution
// has exactly one registration site. A plugin that also registered it from `activate()` would have two
// copies to keep in step — `verify:invariants` refuses an `editor:` on the runtime provider of a plugin
// that has a UI half.
//
// This file is in the PANEL WINDOW'S import graph, which `verify:invariants` bundles and checks: a UI
// entry that reaches the plugin's activation, a receiver, a drawable, an engine or a store would put
// runtime code in a window that must not run any. Add a plugin here only through its `/ui` entry.

import type { RendererPluginUi, RendererPluginUiContext, PluginLiveView, PluginUiHost, RendererHostServices } from '@artlux/sdk/renderer';
import { contentSourceUiRegistry, panelRegistry } from './registries';
import { ui as augmenta } from '@artlux/plugin-augmenta/ui';
import { ui as mediapipe } from '@artlux/plugin-mediapipe/ui';
import { ui as lidarTracking } from '@artlux/plugin-lidar-tracking/ui';
import { ui as ndi } from '@artlux/plugin-ndi/ui';
import { ui as spout } from '@artlux/plugin-spout/ui';
import { ui as syphon } from '@artlux/plugin-syphon/ui';
import { ui as text } from '@artlux/plugin-text/ui';
import { ui as shader } from '@artlux/plugin-shader/ui';

// What only a RUNTIME knows (Spout's and Syphon's "cannot run here", an imported font's load state, a
// shader's compile log and the GPU's limits) is published by that runtime in the editor and read by
// the UI half through `live` — never from the runtime's module, which in a panel window is an idle copy.
// The Calibrator carries only the shader plugin of these (its test cards are shader surfaces).
const FIRST_PARTY_UI: RendererPluginUi[] =
  __ARTLUX_APP__ === 'calibrator' ? [shader] : [augmenta, mediapipe, lidarTracking, ndi, spout, syphon, text, shader];

let activated: RendererPluginUiContext['window'] | null = null;

/** Which kind of window activated the UI halves — 'panel' means no plugin runtime runs here. */
export function pluginUiWindow(): RendererPluginUiContext['window'] | null { return activated; }

// A window with no editor to ask (a projector) reads nothing: every subscription stays at its initial.
const INERT: PluginLiveView = { subscribe: () => () => {}, call: async () => undefined };
// …and has no host either. Stable empty snapshots: a useSyncExternalStore over a fresh `{}` spins.
const NONE = Object.freeze({});
const INERT_HOST: PluginUiHost = {
  settings: { get: () => NONE, subscribe: () => () => {} },
  scene3D: { get: () => NONE, subscribe: () => () => {}, patch: () => {} },
  ui: { menuAction: () => {} },
};

/** The editor's UI host: the host's own services, narrowed to what a UI half may use (PluginUiHost). */
export function uiHostOf(h: RendererHostServices): PluginUiHost {
  return {
    settings: h.settings,
    scene3D: { get: () => h.scene3D.get(), subscribe: (cb) => h.scene3D.subscribe(cb), patch: (p) => h.scene3D.patch(p) },
    ui: { menuAction: (a) => h.ui?.menuAction?.(a) },
  };
}

/**
 * `live` is how a UI half reads what its runtime publishes: a local subscription in the editor
 * (live/pluginLive.ts, via activateRendererPlugins), the live channel in a panel window
 * (live/pluginLiveRemote.ts, from panel.tsx). `host` likewise: the editor's own services (uiHostOf),
 * or the panel window's replica with every write sent to the editor (live/uiHostRemote.ts).
 *
 * Panels registered here land in the window's one panelRegistry: docked by the editor's contexts and,
 * when `detachable`, offered by a panel window's "+" and openable in a window of their own.
 */
export function activatePluginUi(win: RendererPluginUiContext['window'], live: PluginLiveView = INERT, host: PluginUiHost = INERT_HOST): void {
  if (activated) return;
  activated = win;
  const ctx = { window: win, contentSourceUi: contentSourceUiRegistry, live, panels: panelRegistry, host } as unknown as RendererPluginUiContext;
  for (const p of FIRST_PARTY_UI) {
    try { p.activateUi(ctx); } catch (e) { console.error(`[plugins] ${p.id} activateUi failed`, e); }
  }
}
