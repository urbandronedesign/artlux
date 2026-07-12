// Host-side first-party plugin activation (renderer).
//
// In-tree plugins are statically imported (no dynamic disk loading). This module builds the plugin
// context from the host registries + service handles and activates each registered renderer plugin
// once per window. App (main window) calls activateRendererPlugins('main', {...}); each projector
// window calls activateRendererPlugins('projector') so projector-channel `apply()` runs there too.

import {
  contentSourceRegistry, clipKindRegistry, projectorChannelRegistry,
  settingsSectionRegistry, panelRegistry, sceneVizRegistry, projectorPanelRegistry,
  videoCodecRegistry, automationTargetRegistry,
} from './registries';
import { timeline } from '../services/timeline';
import { coreAutomationProvider } from '../services/automationTargets.core';
import { perfMonitor } from '../services/perfMonitor';
import type { RendererPlugin, RendererPluginContext, PluginIpc, RendererHostServices } from '@artlux/sdk/renderer';
import { plugin as lidarTracking } from '@artlux/plugin-lidar-tracking';
import { plugin as ndi } from '@artlux/plugin-ndi/renderer';
import { plugin as calibration } from '@artlux/plugin-calibration/renderer';
import { plugin as spout } from '@artlux/plugin-spout/renderer';
import { plugin as hap } from '@artlux/plugin-hap/renderer';
import { plugin as mp4 } from '@artlux/plugin-mp4';
import { plugin as mediapipe } from '@artlux/plugin-mediapipe';
import { plugin as augmenta } from '@artlux/plugin-augmenta';
import { plugin as showControl } from '@artlux/plugin-show-control/renderer';
import { plugin as audio } from '@artlux/plugin-audio/renderer';

const FIRST_PARTY: RendererPlugin[] = [lidarTracking, ndi, calibration, spout, hap, mp4, mediapipe, augmenta, showControl, audio];

let activated = false;

// Projector windows (and any caller that doesn't own editor state) get inert host services: reads
// return empty, patches/sends are dropped, and projector→main onMessage never fires (only the main
// window owns the bridge ports). The main window (App) injects the real implementations.
const NOOP_HOST: RendererHostServices = {
  projectorOutputs: { get: () => undefined, list: () => [], patch: () => {}, subscribe: () => () => {} },
  scene3D: { get: () => ({}), patch: () => {}, subscribe: () => () => {} },
  projectors: { send: () => {}, onMessage: () => () => {} },
  settings: { get: () => ({}), subscribe: () => () => {} },
  show: {
    getStateMachine: () => ({}), getScenes: () => [], getCueBanks: () => [], getSchedule: () => [],
    setFsmEnabled: () => {}, setSchedule: () => {}, subscribe: () => () => {},
    getStatus: () => ({ playing: false, playhead: 0, showTime: 0, duration: 0, showEnd: 0, showEnded: false, currentStateId: null, stateElapsedSec: 0, activeSceneId: null, lastFiredTransitionId: null }),
    // No editor state here ⇒ no timeline, no selection. Never fires.
    getSelection: () => null, subscribeSelection: () => () => {},
    recallScene: () => {}, fireCue: () => {}, fireColumn: () => {}, transport: () => {},
    triggerTransition: () => {}, enterState: () => {},
  },
  audio: { getMix: () => ({ tracks: [], clips: [], buses: [] }), setMix: () => {}, getTimelineAudio: () => ({ tracks: [], clips: [] }), subscribe: () => () => {} },
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
  for (const p of FIRST_PARTY) {
    try { p.activate(ctx); } catch (e) { console.error(`[plugins] ${p.manifest.id} activate failed`, e); }
  }
}
