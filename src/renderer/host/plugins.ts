// Host-side first-party plugin activation (renderer).
//
// In-tree plugins are statically imported (no dynamic disk loading). This module builds the plugin
// context from the host registries + service handles and activates each registered renderer plugin
// once per window. App (main window) calls activateRendererPlugins('main', {...}); each projector
// window calls activateRendererPlugins('projector') so projector-channel `apply()` runs there too.

import {
  contentSourceRegistry, clipKindRegistry, projectorChannelRegistry,
  settingsSectionRegistry, panelRegistry, contextRegistry, sceneVizRegistry, projectorPanelRegistry,
  smTriggerRegistry,
  videoCodecRegistry, automationTargetRegistry,
} from './registries';
import { timeline } from '../services/timeline';
import { coreAutomationProvider } from '../services/automationTargets.core';
import { perfMonitor } from '../services/perfMonitor';
import type { RendererPlugin, RendererPluginContext, PluginIpc, RendererHostServices, PluginStatus } from '@artlux/sdk/renderer';
import type { BootEntry } from '../../../shared/protocol';
import { plugin as lidarTracking } from '@artlux/plugin-lidar-tracking';
import { plugin as ndi } from '@artlux/plugin-ndi/renderer';
import { plugin as calibration } from '@artlux/plugin-calibration/renderer';
import { plugin as spout } from '@artlux/plugin-spout/renderer';
import { plugin as syphon } from '@artlux/plugin-syphon/renderer';
import { plugin as hap } from '@artlux/plugin-hap/renderer';
import { plugin as mp4 } from '@artlux/plugin-mp4';
import { plugin as mediapipe } from '@artlux/plugin-mediapipe';
import { plugin as augmenta } from '@artlux/plugin-augmenta';
import { plugin as showControl } from '@artlux/plugin-show-control/renderer';
import { plugin as audio } from '@artlux/plugin-audio/renderer';

const FIRST_PARTY: RendererPlugin[] = [lidarTracking, ndi, calibration, spout, syphon, hap, mp4, mediapipe, augmenta, showControl, audio];

// EVERY PLUGIN ACTIVATES. The launch profile no longer decides that, because calibration is two
// halves and only one of them is expensive:
//
//   PLAYBACK  — import a baked .mpcdi and hand it to the projector windows. No camera, no solve, no
//               second venue render; the output warps through one fragment shader. Belongs in EVERY
//               launch, and gating it here is what left a plain editor unable to display a calibrated
//               output at all — the launch you would most want it in.
//   AUTHORING — wizards, camera, OpenCV, structured light, and the venue render a projector window
//               draws while you align it. That is the cost, and the plugin gates it internally on the
//               same `?calibrate=1` every window carries (see plugin.renderer.ts isAuthoringLaunch).
//
// The gate moved INTO the plugin rather than disappearing: the old comment here argued that skipping
// is more honest than "activate but do nothing", and it is right — a Calibration viewport on the rail
// and a panel on every projector window that both decline to work is worse than their absence. What
// changed is that the split is no longer all-or-nothing, and only the plugin knows where the seam is.
//
// ⚠ The figure that comment cited — "60 fps to 17.6" — was a comparison of two DIFFERENT projects.
// Controlled, on one project, it was 38.9 against 34.4. The real cost was never activation; it was
// render-from-projector mounting a second 3D scene per projector window, which a baked map now
// supersedes outright (ProjectorApp.applyCalibMode).
const enabled = (_p: RendererPlugin): boolean => true;

let activated = false;

// Projector windows (and any caller that doesn't own editor state) get inert host services: reads
// return empty, patches/sends are dropped, and projector→main onMessage never fires (only the main
// window owns the bridge ports). The main window (App) injects the real implementations.
const NOOP_HOST: RendererHostServices = {
  // A projector window has no document — null is the honest answer, and it makes a sidecar write
  // degrade to "nowhere to put it" rather than guessing a path.
  project: { path: () => null, save: async () => false },
  projectorOutputs: { get: () => undefined, list: () => [], patch: () => {}, subscribe: () => () => {} },
  surfaces: { list: () => [], get: () => undefined, subscribe: () => () => {} },
  scene3D: { get: () => ({}), patch: () => {}, subscribe: () => () => {}, addModel: async () => null },
  projectors: { send: () => {}, onMessage: () => () => {} },
  settings: { get: () => ({}), subscribe: () => () => {} },
  show: {
    getStateMachine: () => ({}), getScenes: () => [], getCueBanks: () => [], getSchedule: () => [],
    setFsmEnabled: () => {}, setSchedule: () => {}, subscribe: () => () => {},
    // `booting: false` is the honest answer here, not a stub: the cold-start gate holds the SHOW MACHINE,
    // which only the main window runs. A projector is never waiting on a preload.
    getStatus: () => ({ playing: false, playhead: 0, showTime: 0, duration: 0, showEnd: 0, showEnded: false, held: false, currentStateId: null, stateElapsedSec: 0, activeSceneId: null, lastFiredTransitionId: null, booting: false, bootPending: 0 }),
    // No editor state here ⇒ no timeline, no selection. Never fires.
    getSelection: () => null, subscribeSelection: () => () => {},
    recallScene: () => {}, fireCue: () => {}, fireColumn: () => {}, transport: () => {},
    triggerTransition: () => {}, enterState: () => {},
    // No transport here ⇒ no fades to drop a leg from. Inert, like the rest of this host.
    dropFadeLeg: () => {},
  },
  // No editor state here ⇒ no document to write. Both writers are inert: `setMix` (the bed) and
  // `patchTimelineClip` (one clip in the bound timeline's own audio) drop on the floor, exactly like
  // `patch` on the other services above.
  audio: {
    getMix: () => ({ tracks: [], clips: [], buses: [] }), setMix: () => {},
    getTimelineAudio: () => ({ tracks: [], clips: [] }), patchTimelineClip: () => {},
    // Video-clip audio, likewise empty here. (The fresh literals in this stub would be a hazard in the
    // main window — the audio driver's orphan gate compares clip arrays by IDENTITY — but the driver
    // returns early for every window that is not 'main', which is the only kind this host serves.)
    getVideoAudio: () => ({ tracks: [], clips: [] }),
    subscribe: () => () => {},
  },
  // Cold-start readiness. A projector window loads no project and holds no show machine, so a probe
  // registered here would be polled by nobody — accept it and drop it, like every other write above.
  boot: { registerProbe: () => () => {}, isBooting: () => false, elapsedSec: () => 0 },
  // A projector window holds no pools, so a participant here would be driven by nobody.
  preload: { registerParticipant: () => () => {} },
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
    contexts: contextRegistry,
    sceneViz: sceneVizRegistry,
    smTriggers: smTriggerRegistry,
    projectorPanels: projectorPanelRegistry,
    videoCodecs: videoCodecRegistry,
    automationTargets: automationTargetRegistry,
    ipc,
    onPlayhead: (cb) => timeline.subscribe(cb),
    // ~1 Hz poll adapter over perfMonitor (which is polled, not observable) — mirrors onPlayhead.
    onRenderStats: (cb: (s: { fps: number; frameP99: number; workP99: number; longFrames: number }) => void) => {
      const t = setInterval(() => { const s = perfMonitor.stats(); cb({ fps: s.fps, frameP99: s.frameP99, workP99: s.workP99, longFrames: s.longFrames }); }, 1000);
      return () => clearInterval(t);
    },
    host,
  } as unknown as RendererPluginContext;
}

export function activateRendererPlugins(win: 'main' | 'projector', host: RendererHostServices = NOOP_HOST): void {
  if (activated) return;
  activated = true;
  // Core's own automation namespaces (surfaces / fixtures / globalBrightness) register alongside the
  // plugins' — the automation engine doesn't privilege core, it just resolves a path's head to an owner.
  automationTargetRegistry.register(coreAutomationProvider);
  const ctx = makeContext(win, host);
  const report: BootEntry[] = [];
  for (const p of FIRST_PARTY.filter(enabled)) {
    const t0 = performance.now();
    try {
      p.activate(ctx);
      // No status() = 'ok'. A status() that throws leaves the plugin 'ok' with a warning in the log:
      // the contributions ARE registered, only the self-report is broken.
      let st: PluginStatus = { state: 'ok' };
      if (p.status) {
        try { st = p.status(); } catch (e) { console.warn(`[plugins] ${p.manifest.id} status() threw`, e); }
      }
      report.push({
        group: 'renderer', id: p.manifest.id, name: p.manifest.name,
        state: st.state, detail: st.detail, ms: Math.round(performance.now() - t0),
      });
    } catch (e) {
      console.error(`[plugins] ${p.manifest.id} activate failed`, e);
      const msg = e instanceof Error ? e.message : String(e);
      report.push({
        group: 'renderer', id: p.manifest.id, name: p.manifest.name, state: 'error',
        detail: (msg.split('\n')[0] ?? 'activate failed').slice(0, 120),
        ms: Math.round(performance.now() - t0),
      });
    }
  }
  // Hand the second (and last) wave to the startup splash, via main. ONLY from the main window: a
  // projector window activates the same plugins with an inert host, and letting it report would
  // overwrite the editor's real answers with a window that owns no state — and would fire long after
  // the splash is gone, during a show.
  if (win === 'main') window.artlux?.reportBootStatus?.(report);
}
