// LiDAR tracking plugin — renderer activation.
//
// Registers the contributions the host inverted onto registries:
//   • TRACKING content source — the GPU blob drawable for surfaces/clips of type TRACKING.
//   • Live OSC blob ingestion — taps the host's OSC stream (main window only) into the store.
//
// Everything else the LiDAR feature does (the 3D viz, projector self-render, snapshot→projector
// bridge, timeline take record/replay, smoothing config, recording UI) is still driven by host
// code that imports this package's modules transitionally — see the plan's "pragmatic seam".

import { createElement, type ComponentType } from 'react';
import { Scan } from 'lucide-react';
import type { RendererPlugin, RendererPluginContext, ProjectorChannel } from '@artlux/sdk/renderer';
import type { SurfaceContent, VideoClip, Surface } from '@/types';
import type { TrackingZone } from '../../../shared/protocol';
import * as trackingStore from './trackingStore';
import type { TrackingSnapshot } from './trackingStore';
import * as zones from './zones';
import * as people from './people';
import { ZONE_TRIGGER_SOURCE, zoneTriggerFires, describeZoneTrigger, type ZoneTriggerParams } from './zoneTriggers';
import { ZoneTriggerInspector } from './ZoneTriggerInspector';
import * as trackingDrawable from './trackingDrawable';
import * as trackingProjector from './trackingProjector';
import * as take from './trackingTake';

import TrackingViz, { ProviderZonesViz, LIDAR_SURFACES } from './TrackingViz';
import { setSurfaceRegistry } from './trackingHost';
import { buildZoneView } from './zoneViewSource';

let oscUnsub: (() => void) | null = null;
let sceneUnsub: (() => void) | null = null;   // Scene3D → zones.configure
let frameUnsub: (() => void) | null = null;   // per-frame zones.evaluate

export const plugin: RendererPlugin = {
  manifest: { id: 'lidar-tracking', name: 'LiDAR Tracking', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    setSurfaceRegistry(ctx.trackingSurfaces);

    // The OSC Monitor and Trigger Zones panels are the UI HALF's (ui.ts), registered in every window
    // that shows them and detachable into a window of their own. What Trigger Zones shows of THIS side
    // — occupancy, blobs, the people the zones count — is published here, one frame per editor frame
    // while some panel watches (the broker sends a window at most one per frame it draws).
    ctx.live.stream('lidar-tracking.zoneView', {
      watch(onNew) {
        let raf = requestAnimationFrame(function tick() { onNew(); raf = requestAnimationFrame(tick); });
        return () => cancelAnimationFrame(raf);
      },
      read: (params) => buildZoneView(String((params as { surface?: string } | null)?.surface ?? 'SOL')),
    });
    // '3d', not the old 'tracking' context: that one merged into the 3D scene, which is where these
    // monitors' blobs are actually drawn. An extend() against an unknown id queues forever in silence,
    // so verify:invariants checks every target resolves.
    //
    // The ACTION rides along in the host's existing `tracking` group (beside Pose Calibration —
    // groups are matched by name, so appending here joins that cluster rather than starting a new one):
    // the venue workbench is where zones are drawn, so the way in belongs at the top of it, not only
    // in a menu three levels deep.
    ctx.contexts.extend('3d', {
      dock: ['osc-monitor', 'zone-editor'],
      actions: [{
        id: 'zones', label: 'Trigger Zones', group: 'tracking',
        icon: createElement(Scan, { size: 13 }),
        menuAction: 'zone-editor',
      }],
    });

    // TRACKING content: the host compositor dispatches unknown content types through the registry.
    ctx.contentSources.register({
      type: 'TRACKING', // SourceType.TRACKING — kept as a core enum value; only behavior lives here
      getDrawable: (key, content) => trackingDrawable.getFor(key, content as SurfaceContent),
      release: (key) => trackingDrawable.release(key),
      // E2: the native engine draws the blobs itself (engine blobs.rs) from this frame's instances.
      nativeSource: (key, content) => trackingDrawable.nativeSourceFor(key, content as SurfaceContent),
      nativeTick: (key) => trackingDrawable.nativeTickFor(key),
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
      // Read the frame's people; do NOT compute them. people.refresh() ran once this frame from the
      // callback below, and it is the tracker's single caller — computing here as well would advance
      // every track twice against a ~0 dt and make the markers jitter. This throttles at 16 ms so it
      // may serve the previous frame's answer, which is what a preview wants anyway.
      build: () => people.snapshot(),
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
    // …and the zones on OTHER plugins' tracking surfaces (the camera area). Not gated on trackingViz:
    // the provider decides — its toWorld() is null while its own overlay is off, and then this draws
    // nothing. So a camera zone appears with the camera panel, without switching on the LiDAR venue.
    ctx.sceneViz.register({
      id: 'trigger-zones-provider',
      enabled: (s) => ((s as { trackingZones?: { surface: string }[] }).trackingZones ?? []).some((z) => !LIDAR_SURFACES.has(z.surface)),
      Component: ProviderZonesViz as ComponentType<{ scene3D: unknown }>,
    });

    // ── TRIGGER ZONES → the show machine ─────────────────────────────────────────────────────────
    // Main window only: it is the one that runs the state machine (mirrors receive the resulting
    // transport over the bridge), and evaluating zones anywhere else would be work nobody reads.
    if (ctx.window === 'main') {
      // Zones live on Scene3D (persisted project data, core type), so they arrive — and change —
      // through the host scene service. Push them on every scene change; configure() is idempotent
      // and deliberately keeps existing zone STATE, so renaming a zone does not re-fire its triggers.
      const pushZones = (): void => {
        const s = ctx.host.scene3D.get() as { trackingZones?: TrackingZone[]; activeZoneIds?: string[]; trackingMergePeople?: boolean; trackingMergeRadius?: number; trackingSurfaceMerge?: Record<string, boolean>; trackingZoneEnterSec?: number; trackingZoneExitSec?: number };
        // `activeZoneIds` rides the LOOK (a scene recall replaces it), while `trackingZones` is the room
        // and does not — so a GO arrives here as a change of which zones are listened to, nothing more.
        // The venue-wide dwell (the on-site knob) rides along too; a zone follows it unless it overrides.
        // The merge settings describe the SENSOR (does this LiDAR report ~2 blobs per person?) and so
        // are owned by people.ts, which both the zones and the projectors read. They no longer reach
        // zones.configure at all.
        people.configure(!!s.trackingMergePeople, s.trackingMergeRadius ?? 0.8, s.trackingSurfaceMerge);
        zones.configure(s.trackingZones, s.activeZoneIds, s.trackingZoneEnterSec, s.trackingZoneExitSec);
      };
      // Zones on a surface ANOTHER plugin provides (the camera area — 'POSE') read their points
      // through the SDK registry; LiDAR keys are never registered there, so they fall through to people.
      zones.setSurfaceLookup((key) => ctx.trackingSurfaces.get(key));
      pushZones();
      sceneUnsub = ctx.host.scene3D.subscribe(pushZones);
      // Evaluated on the host's per-frame callback — which fires every frame INCLUDING while the
      // transport is paused. That is required, not incidental: a state waiting for a person is
      // usually HOLDING its last frame, and a zone that only advanced with the playhead would never
      // notice anybody arrive.
      // ⚠ ORDER IS LOAD-BEARING: the people for THIS frame, then the zones that count them. One clock
      // reading for both, so a dwell measured by a zone and a position drawn by a projector cannot
      // disagree about when "now" was.
      frameUnsub = ctx.onPlayhead(() => {
        const now = performance.now();
        people.refresh(now);
        zones.evaluate(now);
      });
    }

    // The zone triggers themselves. One `source`, several rules — the host persists
    // `{ kind:'plugin', source:'lidar.zone', params }` and never parses `params`.
    ctx.smTriggers.register({
      source: ZONE_TRIGGER_SOURCE,
      label: 'Trigger zone',
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
    zones.setSurfaceLookup(null); zones.configure([]); zones.evaluate(performance.now()); // releases any camera hold
  },

  // On the startup splash. Renderer-only and native-free, so there is nothing here that can be
  // "unavailable" — it reports WHAT IT CONTRIBUTED, which is the useful answer for a plugin whose
  // whole job is adding surface area. Whether blobs are actually arriving is a live question the OSC
  // Monitor answers; a boot line must not pretend to know it.
  status: () => ({ state: 'ok', detail: 'tracking content · lane · trigger zones · 3D viz' }),
};
