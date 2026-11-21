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

import type { RendererPluginUi, RendererPluginUiContext } from '@artlux/sdk/renderer';
import { contentSourceUiRegistry } from './registries';
import { ui as augmenta } from '@artlux/plugin-augmenta/ui';
import { ui as mediapipe } from '@artlux/plugin-mediapipe/ui';
import { ui as lidarTracking } from '@artlux/plugin-lidar-tracking/ui';
import { ui as ndi } from '@artlux/plugin-ndi/ui';

// Not here yet, and why (each needs state only the editor's runtime holds, which a panel window would
// read from its own idle copy): Spout and Syphon (the sender's "incompatible GPU" status is learned by
// the receiver), Text (the rasterizer reaches the surface media service; font load state is
// per-window), Shader (compile status, GL limits). In a panel window their surfaces say so plainly.
const FIRST_PARTY_UI: RendererPluginUi[] =
  __ARTLUX_APP__ === 'calibrator' ? [] : [augmenta, mediapipe, lidarTracking, ndi];

let activated: RendererPluginUiContext['window'] | null = null;

/** Which kind of window activated the UI halves — 'panel' means no plugin runtime runs here. */
export function pluginUiWindow(): RendererPluginUiContext['window'] | null { return activated; }

export function activatePluginUi(win: RendererPluginUiContext['window']): void {
  if (activated) return;
  activated = win;
  const ctx = { window: win, contentSourceUi: contentSourceUiRegistry } as unknown as RendererPluginUiContext;
  for (const p of FIRST_PARTY_UI) {
    try { p.activateUi(ctx); } catch (e) { console.error(`[plugins] ${p.id} activateUi failed`, e); }
  }
}
