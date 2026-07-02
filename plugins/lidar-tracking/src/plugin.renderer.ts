// LiDAR tracking plugin — renderer activation.
//
// Registers the contributions the host inverted onto registries:
//   • TRACKING content source — the GPU blob drawable for surfaces/clips of type TRACKING.
//   • Live OSC blob ingestion — taps the host's OSC stream (main window only) into the store.
//
// Everything else the LiDAR feature does (the 3D viz, projector self-render, snapshot→projector
// bridge, timeline take record/replay, smoothing config, recording UI) is still driven by host
// code that imports this package's modules transitionally — see the plan's "pragmatic seam".

import type { ComponentType } from 'react';
import type { RendererPlugin, RendererPluginContext, ProjectorChannel } from '@artlux/sdk/renderer';
import type { SurfaceContent, VideoClip, Surface } from '@/types';
import * as trackingStore from './trackingStore';
import type { TrackingSnapshot } from './trackingStore';
import * as trackingDrawable from './trackingDrawable';
import * as take from './trackingTake';
import { clusterAndTrack } from './blobClustering';
import TrackingViz from './TrackingViz';

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

    // The 'tracking' timeline lane kind: takes are .lblob blob recordings, not video — so the engine
    // must skip them in its video sync + Program composite. Replay/record itself is driven by
    // trackingPlayback/trackingRecorder (host-side, via engine.subscribe); this just tells the
    // kind-agnostic engine how to treat the lane. preWarm mirrors trackingPlayback's own preload.
    ctx.clipKinds.register({
      kind: 'tracking',
      skipVideoSync: true,
      excludeFromProgram: true,
      preWarm: (clip) => { const p = (clip as VideoClip).path; if (p) void take.ensureLoaded(p); },
    });

    // Projector data channel: stream the (optionally people-merged) blob snapshot to projector windows
    // showing TRACKING content, over the generic pluginData bridge. Registered in BOTH windows — the
    // host calls `build`/`subscribe` in the main window (producer) and `apply` in each projector
    // window (consumer). Replaces App's former hardcoded { t:'tracking' } bridge.
    ctx.projectorChannels.register({
      channel: 'lidar-tracking',
      throttleMs: 16,
      appliesTo: (surface) => (surface as Surface).content.type === 'TRACKING',
      subscribe: (cb) => trackingStore.subscribe(cb),
      build: () => {
        const raw = trackingStore.snapshot();
        const cfg = ctx.getScene3D() as { trackingMergePeople?: boolean; trackingMergeRadius?: number };
        return cfg.trackingMergePeople ? clusterAndTrack(raw, cfg.trackingMergeRadius ?? 0.8, performance.now()) : raw;
      },
      apply: (payload) => trackingStore.applySnapshot(payload as TrackingSnapshot),
    } as ProjectorChannel);

    // 3D scene overlay: the venue zones + smoothed/predicted/labelled blob markers rendered inside
    // Simulator3D's react-three-fiber <Canvas>. The host mounts registered scene-viz components; this
    // replaces Simulator3D's former direct `import TrackingViz`. Gated on the scene's trackingViz flag.
    // Only the main window has the 3D scene, but registering in both is harmless (no consumer elsewhere).
    ctx.sceneViz.register({
      id: 'lidar-tracking',
      enabled: (s) => (s as { trackingViz?: boolean }).trackingViz === true,
      Component: TrackingViz as ComponentType<{ scene3D: unknown }>,
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
