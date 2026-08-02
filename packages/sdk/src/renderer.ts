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

export type { OscMessage, OscConfig, PluginManifest, PluginState, PluginStatus } from './index.ts';
// A value, not a type — re-exported here so a renderer plugin that already imports from
// `@artlux/sdk/renderer` does not need a second import path for it.
export { nextNumberedName } from './index.ts';

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

// ─── Automation target contribution ───────────────────────────────────────────────────────
// A NAMESPACE of automatable parameters. An automation lane addresses one parameter by dot-path; the
// host resolves the path by its HEAD (the first segment) and hands it to the provider that owns that
// namespace. Everything after the head is the PROVIDER'S OWN GRAMMAR — core never parses it. That is
// what lets the audio plugin expose `audio.clip.<id>.fx.<effectId>.cutoff` without core knowing what a
// filter is, and what keeps the core automation engine generic enough for fixtures/surfaces to use too.
export interface AutomationTargetDef {
  path: string;    // full dot-path, e.g. 'audio.clip.c7.fx.e2.cutoff'
  label: string;   // 'Cutoff'
  group: string;   // section heading in the picker, e.g. 'Bed ▸ Rain ▸ Filter'
  min: number;
  max: number;
  def: number;
  step?: number;   // smallest meaningful change — ALSO the sampler's change-detect epsilon
  unit?: string;
  log?: boolean;   // log response: the lane's Y AXIS and its interpolation both run in log space
  /**
   * AUTHOR IN ONE UNIT, STORE IN ANOTHER — the axis the operator reads, when it differs from the
   * one the value is kept in.
   *
   * `min`/`max` above are NOT a drawing hint: compileAutomation clamps every keyframe to them and
   * hands the result straight to `write()`. So a moving head's Pan lane has to be published 0..1,
   * because that is what lands in `Fixture.dmx` — publishing it as 0..540 would let an operator draw
   * a curve to 540, clamp nothing, and pin the head at its end stop. The cost was that a Pan lane
   * read `0.50` while a pose key for the same channel read `270°`: two units for one thing.
   *
   * This closes that without touching storage. The map is LINEAR from [min,max] onto
   * [display.min,display.max] — numbers, not closures, so a def stays inert data — and it changes
   * only what is DRAWN and TYPED. The stored keyframe, the clamp and the value handed to `write()`
   * are exactly as before.
   */
  display?: { unit: string; min: number; max: number };
}

/** Storage → what the operator reads. Identity when the target declares no display map. */
export const toDisplay = (d: AutomationTargetDef, v: number): number =>
  d.display && d.max !== d.min
    ? d.display.min + ((v - d.min) / (d.max - d.min)) * (d.display.max - d.display.min)
    : v;

/** What the operator typed → storage. The exact inverse of `toDisplay`. */
export const fromDisplay = (d: AutomationTargetDef, v: number): number =>
  d.display && d.display.max !== d.display.min
    ? d.min + ((v - d.display.min) / (d.display.max - d.display.min)) * (d.max - d.min)
    : v;
export interface AutomationTargetProvider {
  /**
   * The path HEADS this provider owns — e.g. ['audio'], or core's ['surfaces','fixtures','globalBrightness'].
   * One owner per head; a provider may own several (paramPath's grammar already spans three).
   */
  namespaces: string[];
  /** Everything automatable right now (the bed changes as clips are added) — drives the target picker. */
  enumerate(): AutomationTargetDef[];
  /** The AUTHORED value (what the slider last wrote), used to seed a new lane. */
  get(path: string): number | undefined;
  /**
   * Push a sampled value. CALLED FROM INSIDE THE rAF FRAME LOOP, so the contract is strict:
   * it MUST NOT touch React state, MUST NOT write the persisted document, and MUST NOT allocate.
   * Write to a LIVE OVERRIDE layer you own — the authored value in the project stays untouched, which
   * is what lets a lane be disabled and the fader snap straight back to what the user actually set.
   */
  write(path: string, value: number): void;
  /** A lane stopped owning this path (disabled, deleted, or dropped by a scene swap) — return it to manual. */
  release(path: string): void;
  /** Optional: called once per frame AFTER all writes, so a provider can flush coalesced changes. */
  frameEnd?(): void;

  /**
   * Optional: A SCENE OR CUE FADE writes here — a layer SEPARATE from the automation override above.
   *
   * Two writers, two maps, and the separation is load-bearing:
   *   · A LANE MUST ALWAYS WIN over a scene fade. Providers implement that by READ ORDER — the value the
   *     provider hands the engine is `laneOverride ?? fadeOverride ?? authored`. No owns() query is needed
   *     and none exists: core cannot see inside a plugin's override layer, by design.
   *   · A lane's release() must never delete a live fade. Sharing one map would make it do exactly that,
   *     and would put two writers in a last-writer-wins race every frame.
   *
   * SAME CONTRACT AS write(): called from inside a rAF frame loop. MUST NOT touch React state, MUST NOT
   * write the persisted document, and MUST NOT push to a device/engine directly — the consumer PULLS the
   * value through on its own next read. (A direct push would be overwritten by the authored value on the
   * same frame by whatever re-reads the document each frame — an audible flutter, not a silent bug.)
   *
   * A fade's value PERSISTS after the fade completes: it IS the recalled scene's state for that param,
   * held outside the saved document exactly as the automation override is. A later recall overwrites it.
   * WHICH IS EXACTLY WHY releaseFade() BELOW IS NOT OPTIONAL IN PRACTICE — see it.
   */
  writeFade?(path: string, value: number): void;

  /**
   * Optional: HAND THE PATH BACK. A MANUAL write to the authored value (an operator moving a fader) is a
   * TAKEOVER — the fade layer for that path must be dropped, or the value the user just set is SHADOWED BY
   * A DEAD FADE FOREVER.
   *
   * This is not hypothetical, it is the default outcome of the layer above. A fade's value persists, and
   * the driver reads `laneOvr ?? fade ?? authored` — so the instant ANY scene or cue touches
   * `audio.master.gain`, the mixer's master fader stops doing anything at all, for the rest of the session
   * and across every project opened in it. An automation lane does not have this bug precisely because it
   * HAS a release, and this codebase already names the failure: a dropped target "must be handed back to
   * manual control, or the target would be STRANDED at the outgoing curve's last value forever".
   */
  releaseFade?(path: string): void;

  /**
   * Optional: drop EVERY fade. The host calls this through the automation-target registry when a project is
   * OPENED or RESET — a fade layer is show state, not document state, and a stale master fade from the
   * previous project must not clamp the new one's output.
   */
  releaseAllFades?(): void;

  /**
   * Optional: the EFFECTIVE value of a path — `laneOverride ?? fadeOverride ?? authored`.
   *
   * `get()` returns the AUTHORED value on purpose (it seeds a new lane's first keyframe, so creating a
   * lane never changes the sound). A FADE'S `from` MUST NOT USE IT: scene A fades the master 1.0 → 0.2;
   * scene B later fades it → 0.5; built from `get()`, B's leg starts at the AUTHORED 1.0 and frame 1 of
   * the fade slams the master to FULL LEVEL before gliding down. A full-scale pop on the second and every
   * subsequent audio recall of the show. Fades read getLive(); lane seeding still reads get().
   */
  getLive?(path: string): number | undefined;
}
export interface AutomationTargetRegistry {
  register(p: AutomationTargetProvider): void;
  get(namespace: string): AutomationTargetProvider | undefined;
  all(): AutomationTargetProvider[];
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
  //
  // KEYED BY PATH, NOT BY CONSUMER — that is deliberate: N surfaces (or timeline content clips) on
  // one file share ONE decoder, which is what makes many simultaneous sources affordable. A codec
  // may therefore see openSurface(p) once and serve several consumers from it.
  //
  // Consequently `closeSurface` means "nobody wants this file any more", NOT "one consumer let go".
  // The HOST refcounts consumers per path (services/contentSource.ts) and calls this only on the
  // last release — do NOT add per-consumer bookkeeping here. Implementations may free the decoder
  // outright. (Before that refcount existed, one surface releasing killed a sibling surface's
  // decoder and the survivor went black permanently.)
  openSurface(path: string): Promise<boolean>;
  surfaceFrame(path: string): CanvasImageSource | null;
  closeSurface(path: string): void;

  // OPTIONAL. A counter that changes only when surfaceFrame() would return NEW pixels. Codecs
  // typically paint into one reused canvas, so callers cannot tell a fresh frame from a repeat by
  // identity — and a 30 fps clip sampled by a 60 Hz loop is half repeats. Consumers that pay a real
  // cost per frame (the projector pump copies the whole surface with createImageBitmap) use this to
  // skip the repeats. Any monotonic value works; the decoded frame index is the natural one.
  // Omit it and callers simply treat every frame as new — correct, just not free.
  surfaceGeneration?(path: string): number | undefined;

  // Timeline layer frame at a clip-local time (playhead-driven). `layerKey` scopes the GPU canvas.
  layerFrame(layerKey: string, path: string, clipTimeSec: number): CanvasImageSource | null;
  releaseLayer(layerKey: string): void;

  setPlaying(playing: boolean): void;      // affects surface playback clocks
  preWarm(path: string): void;             // open/probe ahead of playback

  /**
   * OPTIONAL — "is there a decoded BUFFER here, not just a first frame?"
   *
   * Asked by the host's cold-start gate before it lets a freshly-opened show start (see BootService).
   * A codec that decodes ahead into a ring starts EMPTY: the first seconds of playback then miss the
   * exact frame over and over and paint a neighbour instead, which is a visible stutter at the one
   * moment an audience is guaranteed to be watching. Measured on a 1080p60 HAP show: 167 missed
   * frames in the first ten seconds, then ~none for the rest of the run.
   *
   * `atSec` is CLIP-LOCAL (the source time the layer opens on) and `aheadSec` is how much decoded
   * material the host wants behind the start. Return true when that much is ready.
   *
   * ⚠ IT MUST ALSO KICK THE DECODE. The gate polls this ~10×/s while it holds, and that polling is
   * what fills the ring — a pure predicate would answer "no" forever. Implement it as "top up, then
   * report", and keep it cheap and synchronous.
   *
   * Omit it and the host only waits for the first frame, exactly as before.
   */
  preRoll?(path: string, atSec: number, aheadSec: number): boolean;
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

// ─── Selection ──────────────────────────────────────────────────────────────────────────────
// What the operator currently has selected, in the one shape the shell passes to every panel and
// action. Deliberately ID-ONLY: a panel resolves an id against host state it already reads (core via
// the host's editor store, a plugin via its own state or `ctx.host.*`), so the SDK never has to carry
// the domain model. More than one kind can be live at once — selecting a surface does NOT clear the
// selected fixture — which is why `kinds`/`ids` are plural and `primary` records the last click.
// `fixture.pixel` / `fixture.light` are NARROWINGS of `fixture`, not alternatives to it: a live
// fixture selection publishes `fixture` AND the kind(s) it contains, so a panel says which kind of
// fixture it applies to declaratively (`appliesTo: ['fixture.light']`) instead of opening with an
// `if (f.profileId) return null`. An LED strip and a moving head are two different devices — a
// serpentine toggle is meaningless on a head, a pan channel strip meaningless on tape — and before
// this existed the inspector offered every control for both. A mixed multi-selection publishes both,
// which is correct: `appliesTo` is a FILTER, not an XOR (see below).
export type SelectionKind =
  | 'surface' | 'fixture' | 'fixture.pixel' | 'fixture.light' | 'group' | 'output' | 'model'
  | 'clip' | 'trackingSource' | 'audioChannel';

export interface SelectionSnapshot {
  kinds: SelectionKind[];                              // every kind with a live selection
  ids: Partial<Record<SelectionKind, string[]>>;        // selected ids per kind (absent ⇒ none)
  primary: { kind: SelectionKind; id: string } | null;  // last thing clicked; orders the inspector
}

// ─── Panel contribution ─────────────────────────────────────────────────────────────────────
// A UI panel mounted by the host — the single unit both plugins and core compose the shell out of.
//
// `mount` says WHERE the host puts it. 'modal' is the original kind: a dialog toggled by a menu
// action, mounted only while open, handed `onClose`; it is global and belongs to no workspace
// context. The other four are the mount points the workspace-context shell added (see
// `WorkspaceContext` below) — a context names panel ids and the shell renders them into its browser
// column, its bottom dock, its parameter column, or as the viewport itself. A panel owns its own
// body; the shell owns the surrounding chrome (section header, dock tab, backdrop).
export type PanelMount =
  | 'modal'      // global dialog, toggled by a menu action — NOT part of any context
  | 'browser'    // a section in the context's left browser column
  | 'inspector'  // a parameter section in the context's right column (selection-filtered)
  | 'dock'       // a tab in the context's bottom dock
  | 'viewport';  // the context's main work area

export interface PanelProps {
  onClose?: () => void;          // 'modal' only (host controls open by mounting/unmounting)
  contextId?: string;            // the workspace context rendering this panel (non-modal mounts)
  selection?: SelectionSnapshot; // current selection (non-modal mounts)
}

export interface PanelContribution {
  id: string;
  mount: PanelMount;
  menuAction?: string;          // 'modal' only — host menu action id that toggles the panel
  title?: string;               // section header / dock tab label
  icon?: ReactNode;             // section header / dock tab icon
  // 'inspector' only: render this section only while one of these kinds is selected. Omitted ⇒
  // always rendered. This is a FILTER, not an XOR — a surface AND a fixture can both be live.
  appliesTo?: SelectionKind[];
  defaultOpen?: boolean;        // 'browser' | 'inspector' — collapsed state on first show
  grow?: boolean;               // 'browser' — fill the remaining height and scroll internally
  // 'browser' | 'inspector': skip the shell's section header — the panel draws its own chrome.
  // Used by panels that are already a stack of sections rather than one section.
  bare?: boolean;
  // 'browser' | 'inspector': buttons rendered on the right of the section header (add, auto-patch…).
  // Clicks there do not toggle the section.
  HeaderActions?: ComponentType<PanelProps>;
  Component: ComponentType<PanelProps>;
}

export interface PanelRegistry {
  register(p: PanelContribution): void;
  all(): PanelContribution[];
  get(id: string): PanelContribution | undefined;
  byMount(mount: PanelMount): PanelContribution[];
}

// ─── Workspace context contribution ─────────────────────────────────────────────────────────
// A CONTEXT is a whole workbench for one job — "LED Mapping", "Projection Outputs", "Audio". One is
// active at a time and it declares the entire shell around it: which panels fill the browser column,
// the viewport, the dock and the parameter column, plus the FUNCTIONS on its action bar. The rail
// switches between them.
//
// A context owns no components and no state — it is a manifest of panel ids resolved against
// `PanelRegistry` at render time. That is what lets a plugin ADD to a context it does not own (the
// three tracking plugins all contribute panels to `tracking`) without any host edit.
//
// Contexts are SOFT: they set the default workbench, they do not lock anything away. Opening
// something off-context is allowed and flips the layout badge to 'custom', exactly as a manual panel
// resize already does.
export interface ContextAction {
  id: string;
  label: string;
  icon?: ReactNode;
  group?: string;                                  // cluster on the action bar (a separator between)
  menuAction?: string;                             // reuse an existing host menu action id…
  run?(): void;                                    // …or run directly. One or the other.
  enabled?(selection: SelectionSnapshot): boolean;  // omitted ⇒ always enabled
  danger?: boolean;
  shortcut?: string;                               // display only; binding stays with the host menu
}

// Generic over the host's layout type for the same reason every other contribution here is generic
// over the domain model: the SDK must not import host types. The host instantiates it with
// `WorkspaceLayout`.
export interface WorkspaceContext<Layout = unknown> {
  id: string;
  title: string;                       // full name, shown on the action bar ("LED Mapping")
  shortTitle?: string;                 // ≤5 chars for the 48px rail ("LED"); falls back to `title`
  icon: ReactNode;
  // Rail grouping, in this order, separated by a rule. 'app' is for machine-level workbenches
  // (Preferences) rather than show work — it sits last, below everything you use during a show.
  cluster: 'build' | 'align' | 'show' | 'app';
  order: number;                       // sort within the cluster
  viewport: string;                    // panel id, mount 'viewport'
  // The panel this context offers in its BOTTOM DRAWER — full width, below everything else, with the
  // browser and the parameter column stopping above it. `dock` lives inside the centre column and is
  // flanked by them; this does not. For an editing timeline that distinction is the whole layout: the
  // lanes need the window's full width.
  //
  // It is a DRAWER, not a fixed region: the host renders it collapsed to a title strip and opens it on
  // `WorkspaceLayout.bottomOpen`, which is banked per context. That is why nearly every context names
  // the timeline here — it is a TOOL you pull up while working, not a workbench of its own, and it used
  // to cost a rail entry to reach.
  bottom?: string;
  // The viewport for the OTHER pane while split view is on. Only contexts whose own `viewport` is the
  // 3D scene need it: the host pins that one scene to the right pane (one WebGL context, never
  // remounted), so without a companion the left pane has nothing to show and split view is an empty
  // half. Undefined ⇒ split view shows this context's own viewport on the left, as usual.
  companion?: string;
  browser?: string[];                  // ordered panel ids, mount 'browser'
  dock?: string[];                     // ordered panel ids, mount 'dock' (first = default tab)
  inspector?: string[];                // ordered panel ids, mount 'inspector'
  actions?: ContextAction[];
  layout?: Partial<Layout>;            // this context's default ergonomics (sizes/visibility)
  // Bump when `layout` changes meaningfully. A context banks the operator's own sizes the moment
  // they leave it, and a banked slice always wins over `layout` — otherwise switching away would
  // undo their arrangement. That also means a shipped layout change would NEVER reach anyone who
  // has already visited the context. `layoutRev` is the escape hatch: the host stamps the rev into
  // the banked slice, and re-applies `layout` once when the two differ.
  layoutRev?: number;
  hint?: { en: string; fr: string };   // StatusBar help line while this context is active
}

export interface ContextRegistry<Layout = unknown> {
  register(c: WorkspaceContext<Layout>): void;
  all(): WorkspaceContext<Layout>[];                     // sorted by cluster then order
  get(id: string): WorkspaceContext<Layout> | undefined;
  // Add to a context someone else declared — the "extend a context I don't own" path. Lists append in
  // registration order; a missing context id queues the patch (activation order is not something a
  // plugin should have to know).
  //
  // `viewport` REPLACES rather than appends: a context has exactly one main work area, so this is how a
  // plugin that owns a workbench's principal surface claims it (the audio plugin supplies the mixer for
  // the host-declared `audio` context). Last writer wins; the host's declared viewport is the fallback
  // when no plugin claims it, which is what keeps the context usable with that plugin disabled.
  extend(id: string, patch: { viewport?: string; browser?: string[]; dock?: string[]; inspector?: string[]; actions?: ContextAction[] }): void;
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
  // Offer this panel's own canvas as the window's PICTURE, so the host can put it through the base
  // warp/gamma stage instead of letting it sit on top as an opaque overlay. A panel that draws the
  // whole output (calibration's render-from-projector) needs this because a solve is never perfect in
  // a real venue: the operator must still be able to nudge the result with the ordinary warp handles,
  // and the host owns that stage. The host only consumes it while there IS something to apply — an
  // un-warped output keeps the free compositor path and never reads the canvas. Pass null to withdraw.
  setRenderSource?(canvas: HTMLCanvasElement | null): void;
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

// ─── State-machine trigger contribution ─────────────────────────────────────────────────────
// A condition the show graph can transition on, owned by a plugin: a person entering a LiDAR trigger
// zone, a pose appearing on a camera, a DMX channel crossing a level. The host persists only the
// SHAPE (`SmTrigger { kind: 'plugin', source, params }` — core project data, so a file opens on any
// build); everything about WHAT the condition means lives here.
//
// The FSM evaluates the CURRENT state's outgoing transitions once per frame and fires at most one, so
// `fires` is on the frame path: it must be cheap and side-effect-free. Do the sampling elsewhere (a
// store fed by the plugin's own per-frame hook) and answer from it.
//
// ⚠ RETURN AN EDGE, NOT A LEVEL, unless a level is genuinely what the author asked for. A state can be
// re-entered while the world is still in the condition that caused the last hop — someone is standing
// in the zone — and a level test then fires again on the first frame of the new state, forever. That is
// why `ctx.stateEnteredAtSec` is handed over: compare your own event's timestamp (or sequence counter)
// against it and only fire for something that happened SINCE the state was entered.
export interface SmTriggerEvalContext {
  nowSec: number;             // the FSM's monotonic wall clock (the same one `afterDelay` rides)
  stateEnteredAtSec: number;  // when the CURRENT state was entered, on that clock
  held: boolean;              // the bound timeline is holding its last frame (see ShowService.getStatus)
}

export interface SmTriggerContribution {
  source: string;             // stable id, persisted in the project — e.g. 'lidar.zone'
  label: string;              // shown in the transition inspector's trigger dropdown
  /** Evaluate the condition. Cheap, side-effect-free, called once per frame per candidate edge. */
  fires(params: Record<string, unknown>, ctx: SmTriggerEvalContext): boolean;
  /** One-line summary of a configured trigger, for the graph editor's edge label. */
  describe?(params: Record<string, unknown>): string;
  /** Params editor mounted in the transition inspector. Omit for a parameterless trigger. */
  Inspector?: ComponentType<{ params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }>;
}

export interface SmTriggerRegistry {
  register(t: SmTriggerContribution): void;
  get(source: string): SmTriggerContribution | undefined;
  all(): SmTriggerContribution[];
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

// Read-only view of the rig's surfaces. A plugin that OWNS a workbench needs to name what it is
// working on — the calibration context titles itself "Calibrate — <surface>" — and a surface id is not
// a name. Read + subscribe only: surfaces are core persisted state (see "Core stays core"), so a
// plugin never mutates them through here.
export interface SurfacesService<S = unknown> {
  list(): S[];
  get(id: string): S | undefined;
  subscribe(cb: () => void): () => void;
}

export interface Scene3DService<S = unknown> {
  get(): S;
  patch(partial: Partial<S>): void;
  subscribe(cb: () => void): () => void; // fires when the 3D scene changes
  // Open the native file picker and add the chosen GLB to the venue, placed and named exactly as the
  // Scene panel does it. A service method rather than something a plugin assembles from `patch`,
  // because the placement and naming rules are the host's and a second copy would drift.
  //
  // This exists because the venue model is a PREREQUISITE of calibration but was only reachable from
  // another workspace: the calibration wizard said "Venue model loaded ✗" and offered no way to load
  // one, so the operator had to leave the context, find the Scene panel, come back, and start again.
  // Resolves to the model's id, or null if the picker was cancelled.
  addModel(): Promise<string | null>;
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

// Read-mostly view of the project "show model" (state machine + scenes + cue banks + schedule) for a
// feature plugin that presents/controls it out-of-band (e.g. a tablet remote). Reads return the live
// host state; `setFsmEnabled`/`setSchedule` write back through App (the source of truth). `subscribe`
// fires whenever any of these change so the plugin can re-push a snapshot. Generic over the host
// domain types (opaque here). No-op reads/writes in windows without editor state (projector).
export interface ShowService<SM = unknown, Scene = unknown, Bank = unknown, Entry = unknown> {
  getStateMachine(): SM;
  getScenes(): Scene[];
  getCueBanks(): Bank[];
  getSchedule(): Entry[];
  setFsmEnabled(on: boolean): void;
  setSchedule(entries: Entry[]): void;
  subscribe(cb: () => void): () => void;
  // Live transport + FSM status for a remote's status display (polled by the plugin).
  //
  // TWO PLAYHEADS, ONE TRANSPORT. `playhead` is the BOUND document's time (it restarts when a scene is
  // recalled). `showTime` is the SHOW clock — the time the global audio bed rides, which a scene recall
  // does NOT reset. Anything describing the BED must read showTime; anything describing the picture on
  // the bound timeline must read playhead. See docs/TIMELINE.md.
  //
  // `showEnd` is the SHOW's length (the GLOBAL doc's playable end) — `duration` is the BOUND doc's, and
  // while a scene is bound that number means nothing to the bed.
  //
  // `showEnded` says the show clock is PARKED at showEnd (global loop off, the show ran out). It is NOT
  // derivable from `playing`: a scene looping underneath keeps the transport running. A consumer that
  // reconciles against showTime MUST check it — reconciling against a FROZEN clock is not a no-op, it is
  // a defect (the audio driver's drift re-lock would re-seek every sounding clip back to the same source
  // offset every ~50 ms, forever: a buzz, not silence).
  //
  // A mirror/projector window runs NO show clock: `showTime` is always 0 and `showEnded` always false
  // there (`showEnd` still reads the global document's length). Nothing show-clock-driven exists in a
  // projector — the audio driver early-returns for non-main windows — so this is a floor, not a lie.
  //
  // `booting` says THE SHOW HAS NOT STARTED YET BECAUSE ITS CONTENT IS STILL LOADING — the host holds the
  // state machine on a cold project open until the opening look is decoded (see the `boot` service
  // below). A remote MUST distinguish it from a stopped show: both report `playing: false` and a null
  // `currentStateId`, but one is an operator decision and the other is a two-second wait that will end
  // by itself. Showing "STOPPED" through a preload is how an operator ends up pressing GO over a gate
  // that was about to open. `bootPending` is how many items are still outstanding (0 when not booting).
  //
  // `held` is `showEnded`'s twin on the OTHER clock: THE CURRENT STATE'S PICTURE HAS FINISHED AND THE
  // SHOW HAS NOT. The bound timeline is parked on its last frame (Timeline.holdAtEnd) while the
  // transport keeps running, so the bed and the global automation play on underneath — that is the
  // point of holding rather than pausing. Everything `showEnded`'s note says about reconciling against
  // a frozen clock applies here to the PLAYHEAD-clocked containers, and the same way round: `held` is
  // playhead-scoped and must never silence the bed, exactly as `showEnded` is bed-scoped and must
  // never silence a scene.
  //
  // A REMOTE MUST SHOW IT. A hold reports `playing: true` with a frozen timecode — indistinguishable,
  // on a tablet at the back of a room, from a show that has hung. False there for the same reason
  // `showEnded` is: a projector runs no state machine.
  getStatus(): {
    playing: boolean; playhead: number; showTime: number; duration: number;
    showEnd: number; showEnded: boolean; held: boolean;
    currentStateId: string | null; stateElapsedSec: number;
    activeSceneId: string | null; lastFiredTransitionId: string | null;
    booting: boolean; bootPending: number;
  };
  // The timeline's live selection (ephemeral — never persisted, never in the document, never React state
  // in between). A panel with an inspector that FOLLOWS what the operator clicked subscribes here.
  //
  // `source` says WHICH audio container an audioClip belongs to: the bed (ProjectData.audio) and the bound
  // timeline's own audio (Timeline.audio) can hold the same clip id, and the two commit through different
  // host calls at very different costs. An inspector that guessed would write to the wrong document.
  //
  // THE UNION IS DISCRIMINATED ON PURPOSE — do not flatten it to `source?: 'bed' | 'timeline'`. With an
  // OPTIONAL `source`, narrowing on `kind === 'audioClip'` still leaves `'bed' | 'timeline' | undefined`,
  // and the natural `s.source ?? 'bed'` fallback COMPILES CLEAN while sending a scene-timeline clip's edit
  // down the bed's commit path (host.audio.setMix). That mis-gains the bed — which survives every scene
  // recall — permanently, under a live show. The type must make the guess unrepresentable, not merely
  // discouraged by the paragraph above.
  //
  // THE ID RESOLVES IN THE BOUND DOCUMENT. The publisher (Timeline.tsx) filters the selection against the
  // container it currently holds, so a selection that outlives a document rebind (select a clip on scene
  // A's audio lane, recall scene B) is published as `null` rather than as an id that is in no clip. A
  // consumer should still render nothing when a lookup misses — the bound document can change between the
  // notification and the read — but it will not be handed a permanently dangling id to write through.
  //
  // `subscribeSelection` fires immediately on subscribe (a panel opened mid-show sees the live selection)
  // and then only on a CHANGE — the store is idempotent, so a re-rendering Timeline does not spam it.
  // A window with no editor state (projector) always reads null and never fires.
  getSelection():
    | { kind: 'clip'; id: string }
    | { kind: 'audioClip'; id: string; source: 'bed' | 'timeline' }
    | null;
  subscribeSelection(cb: () => void): () => void;
  // Command surface — the host wires these to the same cueBus/timeline singletons OSC uses, so a
  // remote drives the show through the identical path (App stays the single writer of `playing`).
  recallScene(ref: string): void;                 // scene id or name
  fireCue(ref: string): void;                     // cue id or name
  fireColumn(bank: string, col: number): void;    // 0-based column
  transport(intent: { kind: 'play' | 'pause' | 'stop' | 'seek' | 'loop'; sec?: number; loopOn?: boolean }): void;
  triggerTransition(id: string): void;            // manual FSM transition by id
  enterState(id: string): void;                   // jump directly to a state by id

  /**
   * A MANUAL TAKEOVER OF A FADED PARAM — remove `path` from any IN-FLIGHT scene/cue fade.
   *
   * The provider half of a takeover (AutomationTargetProvider.releaseFade) drops the path from the
   * provider's own fade layer. THAT IS NOT ENOUGH ON ITS OWN, and the gap is not a small one: while a fade
   * is live the host re-writes EVERY faded path through writeFade() on EVERY FRAME. A release that does not
   * also reach the host is therefore undone within 16 ms, and then made PERMANENT when the leg lands on its
   * endpoint and persists there — so the operator's move is erased and the param is stranded at the
   * outgoing scene's value with the control reading as if it had worked. (Scene A fades the master to 0.2
   * over 5 s; two seconds in — exactly when an operator reaches for it — they pull the fader up; without
   * this the house still slides to 0.2 and STAYS.)
   *
   * So a provider's releaseFade() MUST call this. It is on the host contract, not the provider one,
   * because the animation is the HOST's: a plugin cannot reach into it. Both halves, or neither works.
   *
   * Dropping a leg does NOT finalize it (that would write the very value being taken over) and does NOT
   * complete the fade — the fade's OTHER legs keep animating untouched. Unknown/idle paths are a no-op.
   * Inert in windows with no transport (projector), which run no fades to begin with.
   */
  dropFadeLeg(path: string): void;
}

// Read-only view of the persisted global audio bed (ProjectData.audio → AudioMix). The playhead-driven
// bed player (plugins/audio) subscribes here and re-reads getMix() on change. Generic over the host
// domain type (opaque here — the SDK never imports src/renderer/types.ts); App satisfies it structurally
// with the real AudioMix.
//
// TWO AUDIO CONTAINERS, TWO CLOCKS (see docs/TIMELINE.md and getStatus() above):
//   getMix()           — ProjectData.audio, THE BED. Rides the SHOW clock. Survives a scene recall.
//   getTimelineAudio() — the BOUND timeline's own Timeline.audio. Rides the PLAYHEAD, restarts with it.
// The clock follows the CONTAINER, not the panel it happens to be drawn in.
//
// TWO CONTAINERS, TWO WRITERS, AND THEY ARE DELIBERATELY DIFFERENT SHAPES — `setMix` replaces the bed
// (App owns that document outright); `patchTimelineClip` patches ONE clip, BY ID, in whichever document
// core has bound right now (the caller cannot name it). See patchTimelineClip for why the symmetric
// `setTimelineAudio(container)` is not offered.
export interface AudioService<Mix = unknown, TlAudio = unknown, TlClip = unknown> {
  getMix(): Mix;
  setMix(mix: Mix): void;                 // replace the bed (host normalizes) — the bed-authoring UI writes here
  /** The BOUND timeline's own audio ({tracks, clips}) — plays on the PLAYHEAD and restarts with its
   *  timeline, unlike the bed. Reads the ENGINE's bound document, not React state, so it is correct on
   *  the very frame a recall repoints the engine (App re-renders a frame later). Re-read on every
   *  `subscribe` fire — and, in the driver, on every frame. */
  getTimelineAudio(): TlAudio;

  /**
   * THE THIRD CONTAINER — the bound timeline's VIDEO CLIPS' own soundtracks, in the same `{tracks, clips}`
   * shape and on the same clock as `getTimelineAudio()` (the PLAYHEAD, so it restarts with its timeline).
   *
   * DERIVED, NOT AUTHORED. There is no such document: the host recomputes these from the video clips on
   * the timeline, so a move/trim/blade/slip/undo is inherited by construction rather than maintained. The
   * caller must therefore treat them as READ-ONLY — `patchTimelineClip` addresses `Timeline.audio` and
   * will not find a `va:`-prefixed id. To change one, write the VIDEO clip's `audio` block.
   *
   * ⚠ `clips[].path` IS THE SOURCE VIDEO'S PATH — an `.mp4`/`.mov`, which the audio engine CANNOT OPEN.
   * The consumer is expected to map it to something playable (the audio plugin conforms it to a cached
   * WAV) and to drop clips it has no mapping for yet. Core deliberately knows nothing about that step.
   *
   * Returns a REFERENCE-STABLE value while the timeline's layers and clips are unchanged, and a shared
   * frozen empty when nothing contributes — the driver's orphan detector compares clip arrays by identity
   * and this is read every frame.
   */
  getVideoAudio(): TlAudio;

  /**
   * THE SECOND WRITER — patch ONE clip inside the BOUND timeline's own audio (gain, mute, spatial, FX).
   *
   * TWO CONTAINERS, TWO WRITERS, AND THEY ARE NOT SYMMETRIC — read this before reaching for `setMix`.
   *
   *   · `setMix(mix)` replaces THE BED wholesale. The bed is ProjectData.audio: ONE document, owned by
   *     App, never rebound. Handing back a whole container is safe there.
   *   · THIS replaces nothing and names no document. `Timeline.audio` is CORE's document and WHICH ONE it
   *     is changes under you: the global timeline, or the timeline of whichever scene is bound right now.
   *     A `setTimelineAudio(whole container)` would be the obvious symmetric API and it is a trap — the
   *     caller builds the container from a snapshot it read a render ago, so it CLOBBERS any lane edit
   *     (placement / trim / fades) landed since, and it hands the host a payload with NO OWNER IDENTITY,
   *     leaving the host to GUESS which document to write it into. Hence: id-addressed, one clip, a patch.
   *
   * THE CALLER MAY NOT NAME A SCENE, AND THAT IS THE POINT. The host resolves `clipId` inside the BOUND
   * document ONLY and writes it back through the same owner-router every other timeline edit goes through
   * (the active scene's own timeline, else the global one; a scene with no timeline of its own materializes
   * one on this write, exactly as core does). Clip ids ALIAS ACROSS SCENES — "Capture Scene" deep-clones
   * the bound timeline, ids and all, so two scenes hold BYTE-IDENTICAL clip ids — so an API that let a
   * caller (or the host) SEARCH for a matching id would write scene A's reverb into scene B on the very
   * first duplicate, silently, in a venue. **If `clipId` is not in the bound document, the write is
   * DROPPED.** A recall that lands between the gesture and the commit therefore loses the edit, which is
   * correct: the operator is no longer looking at that clip.
   *
   * NOT AN AUTOMATION TARGET. `Timeline.audio` is outside the audio automation provider's world (it
   * enumerates the BED's tracks/clips/master only), so a clip patched here has no lane and no scene/cue
   * fade over it: callers must NOT pair this with releaseFade()/dropFadeLeg() the way the bed's writes do.
   *
   * COSTLY — INVARIANT 7 IS NOT OPTIONAL HERE. One call is a core document commit: engine.setData →
   * clampPlayheadIntoDoc + warmMedia + pruneStaleLayers + compileAutomation, PLUS a structured-clone
   * postMessage of the WHOLE document to EVERY projector port. A continuous control (a fader, a pad, an FX
   * param) must draft locally and call this ONCE, on release — never per pointermove.
   */
  patchTimelineClip(clipId: string, patch: Partial<TlClip>): void;
  subscribe(cb: () => void): () => void;  // fires when EITHER container changes (the bed, or the bound timeline)
}

// ─── Cold-start readiness ─────────────────────────────────────────────────────────────────────
// "Wait for the content, THEN play." On a cold project open the host HOLDS the state machine until the
// look the show opens on is actually decoded, then arms it — otherwise the FSM's `play` entry action
// runs over empty decoders and the opening seconds go out black, on the projectors and on the LED
// output alike (a <video> under readyState 2 is undrawable). The host already waits on what it owns:
// the opening scene's timeline pool and the surfaces' own VIDEO/IMAGE media.
//
// A PLUGIN THAT OWNS LOADING OF ITS OWN registers a probe here — the audio plugin's conforms and engine
// loads are the first, so a show no longer opens with its bed silent for the first bar.
//
// THE CONTRACT, AND IT IS SHORT:
//   · Register ONCE at activate(), not per project — the host re-polls every registered probe on each
//     open. Poll rate is ~10 Hz, so a probe must be a CHEAP synchronous read of state you already keep,
//     never a decode, an await, or an IPC round-trip.
//   · `pending` names what is missing, for the status readout and the timeout log. Return ready:true
//     when you have nothing outstanding — including when your feature is disabled or absent.
//   · NEVER block on something that may never arrive (a live network feed, a camera). The gate fails
//     open on a deadline, but a probe that is structurally unable to finish just burns the venue's
//     patience on every single start.
//   · A probe that throws is treated as ready and logged. Your readiness bug must not hold a show.
export interface BootService {
  /** Register a cold-start readiness probe. Returns an unregister. */
  registerProbe(id: string, probe: () => { ready: boolean; pending?: string[] }): () => void;
  /** Is the host holding the show for a preload right now? */
  isBooting(): boolean;
}

// ─── Project service ────────────────────────────────────────────────────────────────────────
// Where the open document lives on disk. A plugin needs this to write SIDECAR artifacts beside the
// project — data too large to live inside the .artlux but meaningless away from it (the calibration
// plugin's dense per-pixel 3D maps are 10^4–10^5 points each, and the world-space blend cannot be
// re-solved for one projector without the others').
//
// `path()` is null for an unsaved project, and that is not a detail to paper over: an unattended
// process must never trigger a Save dialog, so a caller with no path must degrade, not prompt.
export interface ProjectService {
  /** Absolute path of the open .artlux file, or null when it has never been saved. */
  path(): string | null;
  // Write the document to its existing path. Returns false — never a dialog — when there is no path:
  // an unattended process must not be able to block the machine on a modal nobody will ever click.
  // The write itself is atomic (temp file + rename), so a crash mid-save cannot truncate a project.
  save(): Promise<boolean>;
}

export interface RendererHostServices {
  project: ProjectService;
  projectorOutputs: ProjectorOutputsService;
  surfaces: SurfacesService;
  scene3D: Scene3DService;
  projectors: ProjectorsService;
  settings: SettingsService;
  show: ShowService;
  audio: AudioService;
  boot: BootService;
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
  contexts: ContextRegistry;
  sceneViz: SceneVizRegistry;
  smTriggers: SmTriggerRegistry;
  projectorPanels: ProjectorPanelRegistry;
  videoCodecs: VideoCodecRegistry;
  automationTargets: AutomationTargetRegistry;
  ipc: PluginIpc;
  // Subscribe to the timeline engine's coalesced per-frame playhead (seconds). Returns unsub.
  onPlayhead(cb: (playheadSec: number) => void): () => void;
  // Subscribe to renderer frame-time stats (~1 Hz poll of perfMonitor) — fps + p99 frame/work interval
  // + long (dropped) frames. For a plugin surfacing render health (e.g. a metrics remote). Returns unsub.
  onRenderStats(cb: (stats: { fps: number; frameP99: number; workP99: number; longFrames: number }) => void): () => void;
  // Host capabilities for feature plugins (read/patch outputs + scene, projector I/O). In projector
  // windows the read/patch services are no-ops (no editor state there); `projectors.onMessage` only
  // fires in the main window (it owns the bridge ports). Replaces the former `getScene3D()`.
  host: RendererHostServices;
}

export interface RendererPlugin {
  manifest: import('./index.ts').PluginManifest;
  activate(ctx: RendererPluginContext): void;
  deactivate?(): void;
  /**
   * Optional post-activation self-report (see PluginStatus). Cheap + synchronous; no status = 'ok'.
   * A renderer half reports what it CONTRIBUTED and whether a setting gates it — it must not guess at
   * native availability, which only the main half can see. Cross-process plugins report from both
   * halves and the splash merges them, keeping each answer honest about what it actually knows.
   */
  status?(): import('./index.ts').PluginStatus;
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
