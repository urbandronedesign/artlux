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
import type { TrackingZone } from '../../../shared/protocol';
import * as trackingStore from './trackingStore';
import type { TrackingSnapshot } from './trackingStore';
import * as zones from './zones';
import { ZONE_TRIGGER_SOURCE, zoneTriggerFires, describeZoneTrigger, type ZoneTriggerParams } from './zoneTriggers';
import { ZoneTriggerInspector } from './ZoneTriggerInspector';
import * as trackingDrawable from './trackingDrawable';
import * as trackingProjector from './trackingProjector';
import * as take from './trackingTake';
import { clusterAndTrack } from './blobClustering';
import TrackingViz from './TrackingViz';
import { OscMonitor } from './OscMonitor';
import { ZonePanel } from './ZonePanel';
import { setHost } from './trackingHost';

let oscUnsub: (() => void) | null = null;
let sceneUnsub: (() => void) | null = null;   // Scene3D → zones.configure
let frameUnsub: (() => void) | null = null;   // per-frame zones.evaluate

export const plugin: RendererPlugin = {
  manifest: { id: 'lidar-tracking', name: 'LiDAR Tracking', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Stash host services so the OSC Monitor panel (below) can read live OSC settings for its status strip.
    setHost(ctx.host);

    // OSC Monitor: a diagnostic modal that sniffs the raw OSC stream (LiDAR blob addresses). Registered
    // as a DOCK panel on the `3d` workspace context: the host declares that context, this plugin
    // appends its own tab to it, and the 'osc-monitor' menu action still reaches it (the host resolves
    // the action to the owning context + tab). App imports neither the panel nor its open state.
    ctx.panels.register({ id: 'osc-monitor', mount: 'dock', menuAction: 'osc-monitor', title: 'OSC Monitor', Component: OscMonitor });
    // Trigger Zones: where the venue's interactive areas are drawn. Same seam as the monitor above —
    // the host declares the `3d` context, the plugin appends its own tab to it.
    ctx.panels.register({ id: 'zone-editor', mount: 'dock', title: 'Trigger Zones', Component: ZonePanel });
    // '3d', not the old 'tracking' context: that one merged into the 3D scene, which is where these
    // monitors' blobs are actually drawn. An extend() against an unknown id queues forever in silence,
    // so verify:invariants checks every target resolves.
    ctx.contexts.extend('3d', { dock: ['osc-monitor', 'zone-editor'] });

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
        const cfg = ctx.host.scene3D.get() as { trackingMergePeople?: boolean; trackingMergeRadius?: number };
        return cfg.trackingMergePeople ? clusterAndTrack(raw, cfg.trackingMergeRadius ?? 0.8, performance.now()) : raw;
      },
      apply: (payload) => trackingStore.applySnapshot(payload as TrackingSnapshot),
      // Projector GPU render (consumer side): the plugin composites bg + trails + blobs + overlay
      // into the host's source FBO; the host warps it. Replaces ProjectorGL.drawTracking, so host
      // code no longer imports blobPass / trackingRenderer. Runs in projector windows only.
      projectorSourceSize: (surface) => trackingProjector.sourceSize(surface as Surface),
      renderSource: (gl, surface, host) => trackingProjector.renderSource(gl, surface as Surface, host),
      onConfig: (_surface, render) => trackingProjector.configure(render as { trackingSmoothing?: number; trackingPredictMs?: number }),
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

    // ── TRIGGER ZONES → the show machine ─────────────────────────────────────────────────────────
    // Main window only: it is the one that runs the state machine (mirrors receive the resulting
    // transport over the bridge), and evaluating zones anywhere else would be work nobody reads.
    if (ctx.window === 'main') {
      // Zones live on Scene3D (persisted project data, core type), so they arrive — and change —
      // through the host scene service. Push them on every scene change; configure() is idempotent
      // and deliberately keeps existing zone STATE, so renaming a zone does not re-fire its triggers.
      const pushZones = (): void => {
        const s = ctx.host.scene3D.get() as { trackingZones?: TrackingZone[]; activeZoneIds?: string[]; trackingMergePeople?: boolean; trackingMergeRadius?: number; trackingZoneEnterSec?: number; trackingZoneExitSec?: number };
        // `activeZoneIds` rides the LOOK (a scene recall replaces it), while `trackingZones` is the room
        // and does not — so a GO arrives here as a change of which zones are listened to, nothing more.
        // The venue-wide dwell (the on-site knob) rides along too; a zone follows it unless it overrides.
        zones.configure(s.trackingZones, !!s.trackingMergePeople, s.trackingMergeRadius ?? 0.8, s.activeZoneIds, s.trackingZoneEnterSec, s.trackingZoneExitSec);
      };
      pushZones();
      sceneUnsub = ctx.host.scene3D.subscribe(pushZones);
      // Evaluated on the host's per-frame callback — which fires every frame INCLUDING while the
      // transport is paused. That is required, not incidental: a state waiting for a person is
      // usually HOLDING its last frame, and a zone that only advanced with the playhead would never
      // notice anybody arrive.
      frameUnsub = ctx.onPlayhead(() => zones.evaluate(performance.now()));
    }

    // The zone triggers themselves. One `source`, several rules — the host persists
    // `{ kind:'plugin', source:'lidar.zone', params }` and never parses `params`.
    ctx.smTriggers.register({
      source: ZONE_TRIGGER_SOURCE,
      label: 'LiDAR zone',
      describe: (p) => describeZoneTrigger(p as ZoneTriggerParams),
      fires: (p, c) => zoneTriggerFires(p as ZoneTriggerParams, c),
      Inspector: ZoneTriggerInspector,
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

  deactivate(): void {
    oscUnsub?.(); oscUnsub = null;
    sceneUnsub?.(); sceneUnsub = null;
    frameUnsub?.(); frameUnsub = null;
  },

  // On the startup splash. Renderer-only and native-free, so there is nothing here that can be
  // "unavailable" — it reports WHAT IT CONTRIBUTED, which is the useful answer for a plugin whose
  // whole job is adding surface area. Whether blobs are actually arriving is a live question the OSC
  // Monitor answers; a boot line must not pretend to know it.
  status: () => ({ state: 'ok', detail: 'tracking content · lane · trigger zones · 3D viz' }),
};
