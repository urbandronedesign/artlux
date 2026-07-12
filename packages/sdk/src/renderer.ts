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
}
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
  getStatus(): {
    playing: boolean; playhead: number; showTime: number; duration: number;
    showEnd: number; showEnded: boolean;
    currentStateId: string | null; stateElapsedSec: number;
    activeSceneId: string | null; lastFiredTransitionId: string | null;
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
export interface AudioService<Mix = unknown, TlAudio = unknown> {
  getMix(): Mix;
  setMix(mix: Mix): void;                 // replace the bed (host normalizes) — the bed-authoring UI writes here
  /** The BOUND timeline's own audio ({tracks, clips}) — plays on the PLAYHEAD and restarts with its
   *  timeline, unlike the bed. Reads the ENGINE's bound document, not React state, so it is correct on
   *  the very frame a recall repoints the engine (App re-renders a frame later). Re-read on every
   *  `subscribe` fire — and, in the driver, on every frame. */
  getTimelineAudio(): TlAudio;
  subscribe(cb: () => void): () => void;  // fires when EITHER container changes (the bed, or the bound timeline)
}

export interface RendererHostServices {
  projectorOutputs: ProjectorOutputsService;
  scene3D: Scene3DService;
  projectors: ProjectorsService;
  settings: SettingsService;
  show: ShowService;
  audio: AudioService;
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
