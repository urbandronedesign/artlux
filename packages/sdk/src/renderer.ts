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

import { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
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

// ─── Video codec contribution ─────────────────────────────────────────────────────────────
// A pluggable video decoder for file content the browser `<video>` can't play (HAP; later DXV, or a
// native-decode MP4). The host dispatches a matching file path to the first codec whose `canDecode`
// accepts it. A codec serves two playback contexts: free-running **surface** playback (own clock,
// paused via setPlaying, keyed by file path — a file's live decode is shared) and playhead-driven
// **timeline layer** frames (keyed by a per-layer GL key). Each returns a `CanvasImageSource` the
// compositor draws exactly like a `<video>`/Spout/NDI drawable.
export interface VideoCodecContribution {
  id: string;
  canDecode(path: string): boolean;        // fast synchronous gate (usually by extension)
  probe(path: string): Promise<boolean>;   // async: open natively + confirm; false = not this codec
  probed(path: string): boolean | undefined; // sync: true / false / undefined (still probing)
  aspect(path: string): number | null;     // natural w/h once probed, else null

  // Surface playback (free-running internal clock; keyed by file path). openSurface begins playback
  // and resolves false if the file isn't actually this codec (caller falls back to a plain <video>).
  openSurface(path: string): Promise<boolean>;
  surfaceFrame(path: string): CanvasImageSource | null;
  closeSurface(path: string): void;

  // Timeline layer frame at a clip-local time (playhead-driven). `layerKey` scopes the GPU canvas.
  layerFrame(layerKey: string, path: string, clipTimeSec: number): CanvasImageSource | null;
  releaseLayer(layerKey: string): void;

  setPlaying(playing: boolean): void;      // affects surface playback clocks
  preWarm(path: string): void;             // open/probe ahead of playback
  // One-shot frame at a source time (seconds) for the thumbnail cache (bypasses the playback
  // prefetch ring; uses its own shared GL context so it never disturbs a live layer's decode).
  thumbnail(path: string, timeSec: number): Promise<CanvasImageSource | null>;
}

export interface VideoCodecRegistry {
  register(c: VideoCodecContribution): void;
  all(): VideoCodecContribution[];
  forPath(path: string): VideoCodecContribution | undefined; // first codec whose canDecode(path) is true
  get(id: string): VideoCodecContribution | undefined;
}

// ─── Projector data channel contribution ────────────────────────────────────────────────────
// Bridges per-frame plugin data from the main editor window to projector output windows over the
// existing MessagePort. The host transports a generic { t:'pluginData', channel, payload } message.
// Producer side runs in the main window (build/shouldSend); consumer side runs in each projector
// window (apply, and optionally a per-frame render hook). The same plugin registers both sides;
// the host calls whichever applies to the window it's in.
// Host resources handed to a channel's projector-side GPU render hook (see renderSource). Keeps the
// plugin from importing host services directly — the host injects only what the composite needs.
export interface ProjectorRenderHost {
  timeMs: number; // the projector window's current rAF timestamp (ms)
  getLayerDrawable(layerId: string): Drawable | null; // a timeline layer's decoded frame (e.g. TRACKING bg)
}

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

  // ── Consumer (projector window): GPU render hook ──────────────────────────────────────────
  // A channel may also RENDER its content into the projector's WebGL pipeline, not just apply()
  // data. The plugin composites its own source texture (bg + effects + overlay) into the source
  // framebuffer the host provides; the host then warps that source through its corner-pin/soft-
  // edge/gamma stage. Used for GPU content types that self-render per output (e.g. LiDAR blobs).
  //
  // The source framebuffer size this surface wants this frame; null → this channel isn't rendering
  // (the host falls back to its default draw path). Cheap; polled each frame before renderSource.
  projectorSourceSize?(surface: SurfaceT): { w: number; h: number } | null;
  // Composite this surface's content into the already-bound, (w×h)-sized source framebuffer with
  // raw WebGL. The host owns the FBO lifecycle and warps the result afterward.
  renderSource?(gl: WebGLRenderingContext, surface: SurfaceT, host: ProjectorRenderHost): void;
  // The projector window received updated render config for a surface this channel applies to
  // (e.g. smoothing/prediction). `render` is the host's per-output render config (opaque here).
  onConfig?(surface: SurfaceT, render: unknown): void;
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
// A plugin-owned UI panel mounted by the host. Currently only 'modal' — a dialog toggled by a menu
// action; the host mounts it only while open and passes `onClose`. The panel owns its own chrome + any
// host-services reads (e.g. host.settings) it needs. (Dock / timeline-bin mounts are intentionally NOT
// modelled yet — no plugin needs them, and an unstable SDK shouldn't ship speculative surface. Add a
// mount kind + a host mount point together, when a real consumer appears — see docs/SDK.md.)
export interface PanelProps {
  onClose?: () => void; // provided for 'modal' panels (host controls open by mounting/unmounting)
}

export interface PanelContribution {
  id: string;
  mount: 'modal';
  menuAction?: string; // host menu action id that toggles the panel
  title?: string;
  Component: ComponentType<PanelProps>;
}

export interface PanelRegistry {
  register(p: PanelContribution): void;
  all(): PanelContribution[];
  byMount(mount: PanelContribution['mount']): PanelContribution[];
}

// ─── Projector panel contribution ───────────────────────────────────────────────────────────
// A plugin-contributed full-window overlay MOUNTED IN A PROJECTOR OUTPUT WINDOW (not the editor) —
// e.g. calibration's structured-light pattern, the pose-capture crosshair, and render-from-projector.
// It renders on top of the window's base GL canvas and owns its own React tree, input, and back-channel
// acks. The context is the projector window's bidirectional bridge (the same MessagePort the base
// window uses); `size` is passed separately (reactive). The panel decides from the message stream when
// to show itself — projector windows mount every registered panel.
export interface ProjectorPanelContext<In = unknown, Out = unknown> {
  onMessage(cb: (msg: In) => void): () => void; // main→projector stream for this window; returns unsub
  send(msg: Out): void;                          // projector→main (acks: patternShown / crosshair / confirm)
}

export interface ProjectorPanelContribution {
  id: string;
  Component: ComponentType<{ ctx: ProjectorPanelContext; size: { w: number; h: number } }>;
}

export interface ProjectorPanelRegistry {
  register(p: ProjectorPanelContribution): void;
  all(): ProjectorPanelContribution[];
}

// ─── Scene-viz contribution ─────────────────────────────────────────────────────────────────
// A react-three-fiber component the host's 3D scene (Simulator3D) mounts inside its <Canvas>. Lets
// a plugin draw a 3D overlay (e.g. LiDAR blob markers + zones) without the host importing it. The
// component receives the current `scene3D` state; `enabled` gates it on a scene flag (default on).
// Rendered only in the main window (the editor 3D scene); harmless no-op elsewhere.
export interface SceneVizContribution<Scene = unknown> {
  id: string;
  enabled?(scene3D: Scene): boolean;
  Component: ComponentType<{ scene3D: Scene }>;
}

export interface SceneVizRegistry<Scene = unknown> {
  register(v: SceneVizContribution<Scene>): void;
  all(): SceneVizContribution<Scene>[];
}

// ─── Plugin IPC bridge (renderer side) ──────────────────────────────────────────────────────
// The host preload exposes three generic forwarders so a plugin can talk to its own main-process
// entry without per-plugin preload methods (contextIsolation keeps plugin code out of preload).
export interface PluginIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, cb: (...args: unknown[]) => void): () => void;
}

// ─── Host services ──────────────────────────────────────────────────────────────────────────
// Concrete app capabilities a *feature* plugin (not a content-source/transport) needs to reach —
// read/patch persisted output + scene state, and talk to projector windows. Generic over the host
// domain types (opaque here); the host injects real implementations at activation. This is the
// reusable API growth that lets calibration (and future feature plugins) live outside the core.
export interface ProjectorOutputsService<O = unknown> {
  get(surfaceId: string): O | undefined;
  list(): O[];
  patch(surfaceId: string, partial: Partial<O>): void;
  subscribe(cb: () => void): () => void; // fires when any output changes
}

export interface Scene3DService<S = unknown> {
  get(): S;
  patch(partial: Partial<S>): void;
  subscribe(cb: () => void): () => void; // fires when the 3D scene changes
}

// Read-only view of the persisted app settings (AppSettings), for feature plugins whose UI has no
// props path to them (e.g. a modal panel). Editing settings goes through a SettingsSection instead.
export interface SettingsService<S = unknown> {
  get(): S;
  subscribe(cb: () => void): () => void; // fires when settings change
}

// Talk to projector output windows over the host's MessagePort bridge. `send` is the main→projector
// direction (per surface); `onMessage` is the projector→main back-channel (all surfaces, tagged).
export interface ProjectorsService<Out = unknown, In = unknown> {
  send(surfaceId: string, msg: Out): void;
  onMessage(cb: (surfaceId: string, msg: In) => void): () => void;
}

export interface RendererHostServices {
  projectorOutputs: ProjectorOutputsService;
  scene3D: Scene3DService;
  projectors: ProjectorsService;
  settings: SettingsService;
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
  sceneViz: SceneVizRegistry;
  projectorPanels: ProjectorPanelRegistry;
  videoCodecs: VideoCodecRegistry;
  ipc: PluginIpc;
  // Subscribe to the timeline engine's coalesced per-frame playhead (seconds). Returns unsub.
  onPlayhead(cb: (playheadSec: number) => void): () => void;
  // Host capabilities for feature plugins (read/patch outputs + scene, projector I/O). In projector
  // windows the read/patch services are no-ops (no editor state there); `projectors.onMessage` only
  // fires in the main window (it owns the bridge ports). Replaces the former `getScene3D()`.
  host: RendererHostServices;
}

export interface RendererPlugin {
  manifest: import('./index.ts').PluginManifest;
  activate(ctx: RendererPluginContext): void;
  deactivate?(): void;
}

// ─── useDraggable (the one runtime helper in this entry) ──────────────────────────────────────
// Makes a centered overlay (a modal) draggable by a handle and reports where it was left. Kept
// host-agnostic: PERSISTENCE is injected via load/onCommit, so the SDK never reaches into any host
// storage — the host wires app prefs, a plugin can wire its own (localStorage, plugin IPC, …).
// The offset is a translate DELTA from the element's normal (flex-centered) position, so {0,0} is
// "centered" and it composes with an entrance animation. Put `style={positionerStyle}` on a wrapper
// around the dialog and spread `{...handleProps}` on the header (add `cursor-move select-none`).
// Dragging that starts on a real control (button/input/select) is ignored; double-click recenters.
export type DragOffset = { x: number; y: number };

export function useDraggable(opts?: {
  /** Resolve the saved offset once on mount (async allowed). Falsy → stay centered. */
  load?: () => Promise<DragOffset | null | undefined> | DragOffset | null | undefined;
  /** Called with the new offset after a drag ends or a double-click recenters. */
  onCommit?: (pos: DragOffset) => void;
}): {
  positionerStyle: CSSProperties;
  handleProps: { onPointerDown: (e: ReactPointerEvent) => void; onDoubleClick: () => void };
} {
  const [pos, setPos] = useState<DragOffset>({ x: 0, y: 0 });
  const posRef = useRef(pos); posRef.current = pos;
  const loadRef = useRef(opts?.load); loadRef.current = opts?.load;
  const commitRef = useRef(opts?.onCommit); commitRef.current = opts?.onCommit;

  useEffect(() => {
    let alive = true;
    Promise.resolve(loadRef.current?.()).then((saved) => { if (alive && saved) setPos(saved); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const onPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea,a')) return; // let controls work
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, base = posRef.current;
    const move = (ev: globalThis.PointerEvent) => setPos({ x: base.x + (ev.clientX - sx), y: base.y + (ev.clientY - sy) });
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      commitRef.current?.(posRef.current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDoubleClick = () => { setPos({ x: 0, y: 0 }); commitRef.current?.({ x: 0, y: 0 }); };

  return {
    positionerStyle: { transform: `translate(${pos.x}px, ${pos.y}px)` },
    handleProps: { onPointerDown, onDoubleClick },
  };
}
