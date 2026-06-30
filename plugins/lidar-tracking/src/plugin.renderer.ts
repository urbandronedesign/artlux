// LiDAR tracking plugin — renderer activation.
//
// Registers the contributions the host inverted onto registries:
//   • TRACKING content source — the GPU blob drawable for surfaces/clips of type TRACKING.
//   • Live OSC blob ingestion — taps the host's OSC stream (main window only) into the store.
//
// Everything else the LiDAR feature does (the 3D viz, projector self-render, snapshot→projector
// bridge, timeline take record/replay, smoothing config, recording UI) is still driven by host
// code that imports this package's modules transitionally — see the plan's "pragmatic seam".

import type { RendererPlugin, RendererPluginContext } from '@artlux/sdk/renderer';
import type { SurfaceContent } from '@/types';
import * as trackingStore from './trackingStore';
import * as trackingDrawable from './trackingDrawable';

let oscUnsub: (() => void) | null = null;

export const plugin: RendererPlugin = {
  manifest: { id: 'lidar-tracking', name: 'LiDAR Tracking', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // TRACKING content: the host compositor dispatches unknown content types through the registry.
    ctx.contentSources.register({
      type: 'TRACKING', // SourceType.TRACKING — kept as a core enum value; only behavior lives here
      getDrawable: (key, content) => trackingDrawable.getFor(key, content as SurfaceContent),
      release: (key) => trackingDrawable.release(key),
    });

    // Live OSC blob/spec ingestion. Main window only — projector windows never see OSC (they get
    // snapshots over the bridge). Taps the shared OSC stream alongside the host's control router
    // (the preload bridge supports multiple subscribers). Delivery is array-batched per UDP packet.
    if (ctx.window === 'main') {
      oscUnsub = window.artlux?.onOscMessage?.((msgs) => {
        for (const m of msgs) {
          const v = m.args[0];
          if (typeof v === 'number') trackingStore.ingest(m.address, v);
        }
      }) ?? null;
    }
  },

  deactivate(): void { oscUnsub?.(); oscUnsub = null; },
};
