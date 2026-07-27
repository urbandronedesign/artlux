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
  SmTriggerContribution, SmTriggerRegistry,
  ProjectorPanelContribution, ProjectorPanelRegistry,
  VideoCodecContribution, VideoCodecRegistry,
  AutomationTargetProvider, AutomationTargetRegistry,
  WorkspaceContext, ContextRegistry,
  SelectionSnapshot,
} from '@artlux/sdk/renderer';
import type { SurfaceContent, Surface, VideoClip, AppSettings } from '../types';
import type { WorkspaceLayout } from '../services/layoutStore';
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

// ── State-machine triggers (plugin-owned show-graph conditions) ─────────────────────────────
// Keyed by `source`, the string persisted in `SmTrigger.source`. A MISS IS THE IMPORTANT CASE and is
// deliberately silent: a project can name a trigger this build has no plugin for (the plugin is
// disabled, or the file came from a newer version), and the FSM must then treat that edge as INERT —
// never truthy. Same rule as an automation lane whose namespace has no provider: the data persists,
// it just does not evaluate.
const smTriggers = new Map<string, SmTriggerContribution>();
export const smTriggerRegistry: SmTriggerRegistry = {
  register(t) { smTriggers.set(t.source, t); },
  get(source) { return smTriggers.get(source); },
  all() { return [...smTriggers.values()]; },
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
// Every composable UI unit, core and plugin alike: modals, and the browser/inspector/dock/viewport
// panels a WorkspaceContext names by id. Ids are global — a duplicate registration wins over the
// earlier one so a plugin can deliberately replace a core panel, and warns so an accident is visible.
const panels: PanelContribution[] = [];
export const panelRegistry: PanelRegistry = {
  register(p) {
    const i = panels.findIndex((x) => x.id === p.id);
    if (i >= 0) { console.warn(`[panels] "${p.id}" re-registered — replacing the earlier one`); panels[i] = p; }
    else panels.push(p);
  },
  all() { return panels.slice(); },
  get(id) { return panels.find((p) => p.id === id); },
  byMount(mount) { return panels.filter((p) => p.mount === mount); },
};

// ── Workspace contexts ────────────────────────────────────────────────────────────────────
// The top-level workbenches (LED Mapping, Projection Outputs, …). A context is a MANIFEST of panel
// ids — it owns no components — so `extend` is all a plugin needs to add itself to a context another
// owner declared (the three tracking plugins all append to `tracking`). Extends are queued when they
// arrive before their target registers: plugin activation order is not something a plugin should
// have to know, and the host's own contexts register after the plugin pass in some windows.
const contexts = new Map<string, WorkspaceContext<WorkspaceLayout>>();
type ContextPatch = Parameters<ContextRegistry<WorkspaceLayout>['extend']>[1];
const pendingExtends = new Map<string, ContextPatch[]>();

function applyExtend(c: WorkspaceContext<WorkspaceLayout>, patch: ContextPatch): void {
  if (patch.viewport) c.viewport = patch.viewport; // replaces — a context has one main work area
  if (patch.browser) c.browser = [...(c.browser ?? []), ...patch.browser];
  if (patch.dock) c.dock = [...(c.dock ?? []), ...patch.dock];
  if (patch.inspector) c.inspector = [...(c.inspector ?? []), ...patch.inspector];
  if (patch.actions) c.actions = [...(c.actions ?? []), ...patch.actions];
}

const CLUSTER_ORDER = { build: 0, align: 1, show: 2, app: 3 } as const;

export const contextRegistry: ContextRegistry<WorkspaceLayout> = {
  register(c) {
    contexts.set(c.id, c);
    const queued = pendingExtends.get(c.id);
    if (queued) { for (const p of queued) applyExtend(c, p); pendingExtends.delete(c.id); }
  },
  all() {
    return [...contexts.values()].sort((a, b) =>
      CLUSTER_ORDER[a.cluster] - CLUSTER_ORDER[b.cluster] || a.order - b.order);
  },
  get(id) { return contexts.get(id); },
  extend(id, patch) {
    const c = contexts.get(id);
    if (c) applyExtend(c, patch);
    else pendingExtends.set(id, [...(pendingExtends.get(id) ?? []), patch]);
  },
};

// ── DOES THIS PANEL APPLY TO WHAT IS SELECTED? — ONE RULE, BOTH RENDER PATHS ──────────────────
//
// A parameter section shows when it applies to something currently selected. `appliesTo` omitted
// means "always", and this is a FILTER over the live kinds, not a surface-XOR-fixture rule — a
// surface and a fixture can both contribute sections at once.
//
// IT LIVES HERE, BESIDE THE REGISTRY, BECAUSE THE FILTER EXISTED ON ONLY ONE OF THE TWO RENDER
// PATHS. The hand-built inspector column applied it; `DockRenderer` draws from the dock tree and did
// not — and docking is ON BY DEFAULT, so `appliesTo` was effectively dead: selecting a fixture still
// showed the surface's Content and Transform sections, and vice versa. It was invisible because
// every fixture section applied to `fixture` and every surface section to `surface`, so the only
// symptom was a column longer than it should be. Splitting fixtures into LED and LIGHT kinds turned
// that into a correctness problem — a moving head would keep offering Serpentine, a ledmap upload
// and an LED count — which is how it was found.
//
// registries.ts rather than WorkspaceShell.tsx because WorkspaceShell imports DockRenderer, so an
// export there would be a cycle. Both already import this module.
export const appliesToSelection = (p: PanelContribution, selection: SelectionSnapshot): boolean =>
  !p.appliesTo || p.appliesTo.some((k) => selection.kinds.includes(k));
