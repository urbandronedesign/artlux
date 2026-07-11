// Host-side plugin contribution registries (renderer process).
//
// These are the concrete, host-typed implementations of the registry contracts in
// `@artlux/sdk/renderer`. They are plain Map-backed singletons: a plugin's renderer `activate()`
// registers contributions here (via the plugin context), and host code (compositor, timeline,
// projector bridge, Preferences, panel host) reads them.
//
// Phase 1: the registries exist but nothing registers into them yet, so host behavior is
// unchanged (every lookup misses and the built-in hardcoded paths run as before). Phase 2 moves
// the LiDAR feature onto them.

import type {
  ContentSourceProvider, ContentSourceRegistry,
  ClipKindContribution, ClipKindRegistry,
  ProjectorChannel, ProjectorChannelRegistry,
  SettingsSection, SettingsSectionRegistry,
  PanelContribution, PanelRegistry,
  SceneVizContribution, SceneVizRegistry,
  ProjectorPanelContribution, ProjectorPanelRegistry,
  VideoCodecContribution, VideoCodecRegistry,
  AutomationTargetProvider, AutomationTargetRegistry,
} from '@artlux/sdk/renderer';
import type { SurfaceContent, Surface, VideoClip, AppSettings } from '../types';
import type { Scene3D } from '../../../shared/protocol';

// ── Content sources ───────────────────────────────────────────────────────────────────────
const contentProviders = new Map<string, ContentSourceProvider<SurfaceContent>>();
export const contentSourceRegistry: ContentSourceRegistry<SurfaceContent> = {
  register(p) { contentProviders.set(p.type, p); },
  get(type) { return contentProviders.get(type); },
  all() { return [...contentProviders.values()]; },
};

// ── Timeline clip kinds ───────────────────────────────────────────────────────────────────
const clipKinds = new Map<string, ClipKindContribution<VideoClip>>();
export const clipKindRegistry: ClipKindRegistry<VideoClip> = {
  register(c) { clipKinds.set(c.kind, c); },
  has(kind) { return kind != null && clipKinds.has(kind); },
  get(kind) { return clipKinds.get(kind); },
};

// ── Projector data channels ───────────────────────────────────────────────────────────────
const projectorChannels = new Map<string, ProjectorChannel<Surface>>();
export const projectorChannelRegistry: ProjectorChannelRegistry<Surface> = {
  register(c) { projectorChannels.set(c.channel, c); },
  all() { return [...projectorChannels.values()]; },
  get(channel) { return projectorChannels.get(channel); },
};

// ── Automation targets ────────────────────────────────────────────────────────────────────
// One provider per PATH NAMESPACE (the head of a lane's targetPath). The automation sampler resolves a
// lane by its head and hands the value to the owner; core never parses the rest of the path.
const automationProviders = new Map<string, AutomationTargetProvider>();
export const automationTargetRegistry: AutomationTargetRegistry = {
  register(p) { for (const ns of p.namespaces) automationProviders.set(ns, p); },
  get(namespace) { return automationProviders.get(namespace); },
  all() { return [...new Set(automationProviders.values())]; }, // a provider owning N heads appears once
};

// ── Settings sections ─────────────────────────────────────────────────────────────────────
const settingsSections: SettingsSection<AppSettings>[] = [];
export const settingsSectionRegistry: SettingsSectionRegistry<AppSettings> = {
  register(s) { settingsSections.push(s); },
  all() { return settingsSections.slice(); },
};

// ── Scene-viz (3D overlays) ─────────────────────────────────────────────────────────────────
const sceneVizzes: SceneVizContribution<Scene3D>[] = [];
export const sceneVizRegistry: SceneVizRegistry<Scene3D> = {
  register(v) { sceneVizzes.push(v); },
  all() { return sceneVizzes.slice(); },
};

// ── Video codecs (pluggable decoders for non-<video> file content, e.g. HAP) ────────────────
const videoCodecs: VideoCodecContribution[] = [];
export const videoCodecRegistry: VideoCodecRegistry = {
  register(c) { videoCodecs.push(c); },
  all() { return videoCodecs.slice(); },
  forPath(path) { return videoCodecs.find((c) => c.canDecode(path)); },
  get(id) { return videoCodecs.find((c) => c.id === id); },
};

// ── Projector panels (full-window overlays in projector output windows) ─────────────────────
const projectorPanels: ProjectorPanelContribution[] = [];
export const projectorPanelRegistry: ProjectorPanelRegistry = {
  register(p) { projectorPanels.push(p); },
  all() { return projectorPanels.slice(); },
};

// ── Panels ────────────────────────────────────────────────────────────────────────────────
const panels: PanelContribution[] = [];
export const panelRegistry: PanelRegistry = {
  register(p) { panels.push(p); },
  all() { return panels.slice(); },
  byMount(mount) { return panels.filter((p) => p.mount === mount); },
};
