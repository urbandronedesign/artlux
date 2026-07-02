// @artlux/sdk/renderer — renderer-process (browser/React/WebGL) contribution contracts.
//
// May use `react` / DOM / WebGL types. NEVER import `node:*` from this entry. STATUS: internal +
// UNSTABLE (see ./index.ts).
//
// The contribution interfaces are GENERIC over the host domain types (SurfaceContent, Surface,
// VideoClip, AppSettings) rather than importing them: that keeps the runtime dependency direction
// clean (plugin → sdk only, never plugin → host). The host instantiates each registry with its
// real types (full host-side type safety); an in-tree plugin parameterizes the generics with the
// host types it imports type-only. Moving the domain model into the SDK is a later-phase decision.

import type { ComponentType, ReactNode } from 'react';
import type { OscMessage, OscConfig } from './index.ts';

export type { OscMessage, OscConfig, PluginManifest } from './index.ts';

// A drawable surface source — same as the host compositor's `CanvasImageSource`.
export type Drawable = CanvasImageSource;

// ─── Content source contribution ────────────────────────────────────────────────────────────
// Turns a consumer's content (a surface's or timeline clip's `SurfaceContent`) into a per-frame
// drawable. The host keeps built-in types (VIDEO/IMAGE/CAMERA/SPOUT/NDI/EFFECT) on explicit hot-
// path switch cases; only plugin-contributed types are dispatched through this registry.
export interface ContentSourceProvider<C = unknown, D = Drawable> {
  type: string; // the SurfaceContent.type value this provider serves, e.g. 'TRACKING'
  acquire?(key: string, content: C): void;
  release?(key: string): void;
  getDrawable(key: string, content: C, timeSec: number): D | null;
  getAspect?(key: string, content: C): number | null;
  // UI fragment shown in the content editor when this type is selected.
  editor?: ComponentType<{ content: C; onChange: (patch: Partial<C>) => void }>;
  // Optional button shown in the content-type picker.
  pickerButton?: { label: string; title?: string; icon?: ReactNode };
}

export interface ContentSourceRegistry<C = unknown, D = Drawable> {
  register(provider: ContentSourceProvider<C, D>): void;
  get(type: string): ContentSourceProvider<C, D> | undefined;
  all(): ContentSourceProvider<C, D>[];
}

// ─── Timeline clip-kind contribution ────────────────────────────────────────────────────────
// A non-video lane kind (e.g. 'tracking' takes). The playback/record loop itself lives in the
// plugin and couples to the engine only via the public `timeline.subscribe(playhead)` API; this
// contribution just tells the kind-agnostic engine how to treat the lane.
export interface ClipKindContribution<Clip = unknown> {
  kind: string;
  excludeFromProgram?: boolean; // omitted from the PROGRAM composite + solo set
  skipVideoSync?: boolean;      // not decoded on the per-frame video sync path
  preWarm?(clip: Clip): void;   // optional pre-load when the timeline data is set
}

export interface ClipKindRegistry<Clip = unknown> {
  register(c: ClipKindContribution<Clip>): void;
  has(kind: string | undefined): boolean;
  get(kind: string): ClipKindContribution<Clip> | undefined;
}

// ─── Projector data channel contribution ────────────────────────────────────────────────────
// Bridges per-frame plugin data from the main editor window to projector output windows over the
// existing MessagePort. The host transports a generic { t:'pluginData', channel, payload } message.
// Producer side runs in the main window (build/shouldSend); consumer side runs in each projector
// window (apply, and optionally a per-frame render hook). The same plugin registers both sides;
// the host calls whichever applies to the window it's in.
export interface ProjectorChannel<SurfaceT = unknown, Payload = unknown> {
  channel: string;
  // Producer (main window): which projector surfaces receive this channel's data (per-surface gate).
  appliesTo?(surface: SurfaceT): boolean;
  // Producer (main window): fire the callback when the payload changes → the host sends. Returns unsub.
  // Omit for a poll-per-frame channel (the host then sends every transport tick, throttled).
  subscribe?(onChange: () => void): () => void;
  // Producer (main window): build the payload to send (null = skip this send).
  build?(): Payload | null;
  // Producer: minimum ms between sends (default 16 ≈ 60fps).
  throttleMs?: number;
  // Consumer (projector window): apply a received payload to local state.
  apply?(payload: Payload): void;
}

export interface ProjectorChannelRegistry<SurfaceT = unknown, Payload = unknown> {
  register(c: ProjectorChannel<SurfaceT, Payload>): void;
  all(): ProjectorChannel<SurfaceT, Payload>[];
  get(channel: string): ProjectorChannel<SurfaceT, Payload> | undefined;
}

// ─── Settings section contribution ──────────────────────────────────────────────────────────
// A plugin-owned block rendered in Preferences. `defaults` is merged into the host's settings
// defaults so old projects load cleanly.
export interface SettingsSection<S = unknown> {
  id: string;
  title: string;
  icon?: ReactNode;
  defaults?: Partial<S>;
  Component: ComponentType<{ settings: S; onChange: (patch: Partial<S>) => void }>;
}

export interface SettingsSectionRegistry<S = unknown> {
  register(s: SettingsSection<S>): void;
  all(): SettingsSection<S>[];
}

// ─── Panel contribution ─────────────────────────────────────────────────────────────────────
// A plugin-owned UI panel mounted by the host. 'modal' = right-side dialog toggled by a menu
// action; 'timeline-bin' = a panel inside the timeline dock.
export interface PanelContribution {
  id: string;
  mount: 'modal' | 'dock' | 'timeline-bin';
  menuAction?: string; // host menu action id that toggles a 'modal' panel
  title?: string;
  Component: ComponentType<Record<string, never>>;
}

export interface PanelRegistry {
  register(p: PanelContribution): void;
  all(): PanelContribution[];
  byMount(mount: PanelContribution['mount']): PanelContribution[];
}

// ─── Plugin IPC bridge (renderer side) ──────────────────────────────────────────────────────
// The host preload exposes three generic forwarders so a plugin can talk to its own main-process
// entry without per-plugin preload methods (contextIsolation keeps plugin code out of preload).
export interface PluginIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

// ─── Renderer plugin context ────────────────────────────────────────────────────────────────
// Handed to a plugin's renderer `activate()`. Carries the contribution registries plus the host
// service handles a plugin needs. Concrete (host-typed) in the host; generic here.
export interface RendererPluginContext<C = unknown, SurfaceT = unknown, Clip = unknown, S = unknown> {
  window: 'main' | 'projector';
  contentSources: ContentSourceRegistry<C>;
  clipKinds: ClipKindRegistry<Clip>;
  projectorChannels: ProjectorChannelRegistry<SurfaceT>;
  settings: SettingsSectionRegistry<S>;
  panels: PanelRegistry;
  ipc: PluginIpc;
  // Subscribe to the timeline engine's coalesced per-frame playhead (seconds). Returns unsub.
  onPlayhead(cb: (playheadSec: number) => void): () => void;
  // Read the current 3D scene state (models, tracking/merge config, …). Main window only; a
  // general host accessor — e.g. the LiDAR projector channel reads its merge config from here.
  getScene3D(): unknown;
}

export interface RendererPlugin {
  manifest: import('./index.ts').PluginManifest;
  activate(ctx: RendererPluginContext): void;
  deactivate?(): void;
}
