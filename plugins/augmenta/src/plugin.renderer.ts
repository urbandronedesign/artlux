// Augmenta tracking plugin — renderer activation.
//
// Registers the contributions the host inverted onto its registries, mirroring the MediaPipe plugin:
//   • AUGMENTA content source — the GPU object-marker drawable for surfaces/clips of type AUGMENTA.
//   • 'augmenta' clip kind    — teaches the timeline engine to treat the lane as non-video.
//   • 'augmenta' projector channel — snapshots objects to projector windows + self-renders there.
//   • Scene-viz overlay       — the 3D field + object markers (gated on scene.augmentaViz).
//   • Augmenta Monitor panel + settings section — a live OSC debug modal + setup guidance.
//   • Live OSC ingestion      — taps the host's shared OSC stream (main window only) into the store.
//
// Augmenta shares the host's single OSC UDP listener (like the LiDAR blob addresses), so there's no
// main-process half: the box points its OSC v2 output at the app's OSC listen port, and the /au/…
// messages fall through the host control router (which only claims the /artlux prefix) to us here.

import type { ComponentType } from 'react';
import type { RendererPlugin, RendererPluginContext, ProjectorChannel } from '@artlux/sdk/renderer';
import type { SurfaceContent, Surface } from '@/types';
import * as augmentaStore from './augmentaStore';
import type { AugmentaSnapshot } from './augmentaStore';
import * as augmentaDrawable from './augmentaDrawable';
import * as augmentaProjector from './augmentaProjector';
import AugmentaViz from './AugmentaViz';
import { AugmentaMonitor } from './AugmentaMonitor';
import { AugmentaSettings } from './augmentaSettings';
import { AugmentaContentEditor } from './augmentaContentEditor';
import { setHost } from './augmentaHost';

let oscUnsub: (() => void) | null = null;

export const plugin: RendererPlugin = {
  manifest: { id: 'augmenta', name: 'Augmenta Tracking', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    // Stash host services so the Monitor panel + settings section can read live OSC settings.
    setHost(ctx.host);

    // Augmenta Monitor: a diagnostic panel that sniffs the raw OSC stream (/au/ addresses). A DOCK tab
    // appended to the host's `tracking` context, beside the other tracking sources' monitors.
    ctx.panels.register({ id: 'augmenta-monitor', mount: 'dock', menuAction: 'augmenta-monitor', title: 'Augmenta Monitor', Component: AugmentaMonitor });
    ctx.contexts.extend('tracking', { dock: ['augmenta-monitor'] });

    // Preferences section: OSC status + setup guidance (Augmenta has no plugin-local device settings —
    // it reuses the core OSC / Tracking receive settings).
    ctx.settings.register({ id: 'augmenta', title: 'Augmenta Tracking', Component: AugmentaSettings });

    // AUGMENTA content: the host compositor dispatches unknown content types through the registry.
    ctx.contentSources.register({
      type: 'AUGMENTA', // SourceType.AUGMENTA — kept as a core enum value; only behavior lives here
      getDrawable: (key, content) => augmentaDrawable.getFor(key, content as SurfaceContent),
      release: (key) => augmentaDrawable.release(key),
      editor: AugmentaContentEditor,
      pickerButton: { label: 'Augmenta', title: 'Augmenta box optical tracking (OSC)' },
    });

    // The 'augmenta' timeline lane kind: a live tracking source, not video — skip it on the video sync
    // path and exclude it from the PROGRAM composite (parity with the 'tracking'/'mediapipe' lanes).
    ctx.clipKinds.register({ kind: 'augmenta', skipVideoSync: true, excludeFromProgram: true });

    // Projector data channel: stream the object snapshot to projector windows showing AUGMENTA content
    // + self-render there. Registered in BOTH windows — the host calls build/subscribe in the main
    // window (producer) and apply + the GPU trio in each projector window (consumer).
    ctx.projectorChannels.register({
      channel: 'augmenta',
      throttleMs: 16,
      appliesTo: (surface) => (surface as Surface).content.type === 'AUGMENTA',
      subscribe: (cb) => augmentaStore.subscribe(cb),
      build: () => augmentaStore.snapshot(),
      apply: (payload) => augmentaStore.applySnapshot(payload as AugmentaSnapshot),
      projectorSourceSize: (surface) => augmentaProjector.sourceSize(surface as Surface),
      renderSource: (gl, surface, host) => augmentaProjector.renderSource(gl, surface as Surface, host),
      onConfig: (_surface, render) => augmentaProjector.configure(render as { trackingSmoothing?: number; trackingPredictMs?: number }),
    } as ProjectorChannel);

    // 3D scene overlay: the field rectangle + object markers rendered inside Simulator3D's <Canvas>.
    // Gated on the scene's augmentaViz flag (default off).
    ctx.sceneViz.register({
      id: 'augmenta',
      enabled: (s) => (s as { augmentaViz?: boolean }).augmentaViz === true,
      Component: AugmentaViz as ComponentType<{ scene3D: unknown }>,
    });

    // Live OSC ingestion. Main window only — projector windows never see OSC (they get snapshots over
    // the bridge). Taps the shared OSC stream alongside the host's control router (the preload bridge
    // supports multiple subscribers). Delivery is array-batched per UDP packet; the store parses the
    // whole batch and upserts objects by id.
    if (ctx.window === 'main') {
      oscUnsub = window.artlux?.onOscMessage?.((msgs) => { augmentaStore.ingestBundle(msgs); }) ?? null;
    }
  },

  deactivate(): void { oscUnsub?.(); oscUnsub = null; },

  // On the startup splash. Shares the host's OSC listener rather than binding its own port, so there is
  // no socket here that could fail — only contributions to report.
  status: () => ({ state: 'ok', detail: 'OSC v2 tracking source · monitor · 3D viz' }),
};
