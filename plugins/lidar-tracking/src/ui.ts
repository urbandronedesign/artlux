// The LiDAR tracking plugin's UI HALF (E5/W5). TRACKING content has nothing to set up in the content
// editor (its settings are the core OSC / Tracking preferences), and it says so by registering an entry
// WITHOUT an editor: a type with no entry at all tells a panel window "this is set up in the editor".
//
// Its two panels are here too, and may open in their own window:
//   OSC MONITOR   — taps the OSC wire itself (main sends it to any window that listens), and shows the
//                   listener settings through the UI host.
//   TRIGGER ZONES — the zones are project data (the UI host's scene3D); occupancy, blobs and people
//                   are the runtime's, read from the 'lidar-tracking.zoneView' stream (uiLink.ts).
import type { RendererPluginUi, ContentSourceUiRegistry } from '@artlux/sdk/renderer';
import { OscMonitor } from './OscMonitor';
import { ZonePanel } from './ZonePanel';
import { setLiveView, setUiHost } from './uiLink';

export const ui: RendererPluginUi = {
  id: 'lidar-tracking',
  activateUi(ctx) {
    setLiveView(ctx.live);
    setUiHost(ctx.host);
    (ctx.contentSourceUi as ContentSourceUiRegistry).register({ type: 'TRACKING' });
    // DOCK panels on the `3d` workspace context (the runtime's extend() puts them there); the menu
    // action reaches them wherever they are (the host resolves it to the owning context + tab).
    //
    // `menuAction` on Trigger Zones is not decoration. This is the AUTHORING surface for zones — the
    // thing an operator goes looking for by name — and being the fourth unlabelled text tab in a
    // six-tab dock strip is not being findable: the feature reads as missing.
    ctx.panels.register({ id: 'osc-monitor', mount: 'dock', detachable: true, menuAction: 'osc-monitor', title: 'OSC Monitor', Component: OscMonitor });
    ctx.panels.register({ id: 'zone-editor', mount: 'dock', detachable: true, menuAction: 'zone-editor', title: 'Trigger Zones', Component: ZonePanel });
  },
};
