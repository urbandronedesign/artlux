import type { Scene3D, ProjectorOutput } from '../../shared/protocol';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBW extends RGB {
  w: number;
}

export enum PixelSource {
  MEDIA = 'MEDIA',   // sample the video/image source at the fixture's position
  EFFECT = 'EFFECT'  // generate color from a built-in effect + palette
}

export enum LedShape {
  LINE = 'LINE',
  MATRIX = 'MATRIX'
}

// A contiguous LED sub-range of a fixture. When a fixture has no segments, the
// whole fixture acts as one implicit segment.
export interface Segment {
  start: number;   // first LED index within the fixture (inclusive)
  stop: number;    // last LED index (exclusive)
  off?: boolean;   // true => this segment's LEDs output black (an authored "gap"/dead span)
  // The fields below are retired legacy: since S3 every segment samples its linked surface's
  // texture (effects live on surfaces now, see gpu/surfaceFx.ts). They are kept ONLY so old
  // projects round-trip and so cue/fade paths (fixtures.<id>.segments.<n>.speed|intensity in
  // services/paramPath.ts) don't strand. Do NOT wire UI back to them — the Inspector no longer
  // authors them. @deprecated
  source: PixelSource;
  effectId: number;
  paletteId: number;
  speed: number;
  intensity: number;
}

// Physical wiring order of the color channels on the strip/pixel.
export enum ColorOrder {
  RGB = 'RGB', RBG = 'RBG', GRB = 'GRB', GBR = 'GBR', BRG = 'BRG', BGR = 'BGR'
}

// How the white channel is derived (RGBW fixtures).
export enum RGBWMode {
  SUBTRACT = 'SUBTRACT', // W = min(r,g,b); colored channels get min removed (default)
  NONE = 'NONE'          // W = 0; full RGB kept (use for RGB strips)
}

export interface Fixture {
  id: string;
  name: string;
  x: number; // Normalized 0-1 relative to stage width
  y: number; // Normalized 0-1 relative to stage height
  width: number; // Normalized 0-1
  height: number; // Normalized 0-1
  rotation: number; // Degrees
  universe: number;
  startAddress: number;
  ledCount: number;
  reverse: boolean;
  colorData: RGBW[]; // Live data
  // Phase C — effects/palettes (optional for back-compat; default to MEDIA).
  source?: PixelSource;
  effectId?: number;   // index into EFFECT_NAMES
  paletteId?: number;  // index into PALETTE_NAMES
  speed?: number;      // 0..1
  intensity?: number;  // 0..1
  segments?: Segment[]; // Phase H — multi-segment effects (optional)
  // Phase D — 2D matrix + ledmap + color correctness (optional; defaults keep
  // existing output identical: LINE / RGB order / SUBTRACT / 4 channels).
  shape?: LedShape;
  matrixWidth?: number;
  matrixHeight?: number;
  serpentine?: boolean;
  ledMap?: number[];          // physical index -> geometry index
  colorOrder?: ColorOrder;
  rgbwMode?: RGBWMode;
  channelsPerPixel?: 3 | 4;
  // Phase E — per-fixture output routing ("jump from fixture to fixture").
  output?: OutputTarget;
  // Surfaces — the surface this fixture samples (strict per-surface sampling, S3).
  surfaceId?: string;
  // S5 — physical output device this fixture is patched to; auto-patch computes
  // universe/startAddress unless patchLocked.
  controllerId?: string;
  patchLocked?: boolean;
  // Phase G — 3D physical layout (optional; derived from 2D when absent).
  position3D?: Vec3;
  rotation3D?: Euler3;   // degrees
  layout3D?: Layout3D;
  scale3D?: number;      // uniform scale of the physical LED layout (1 = as authored)
}

export interface Vec3 { x: number; y: number; z: number; }
export interface Euler3 { pitch: number; yaw: number; roll: number; } // degrees

export type Layout3DType = 'line' | 'matrix' | 'arc';

export interface Layout3D {
  type: Layout3DType;
  ledSpacing: number;   // meters between adjacent LEDs (line/matrix)
  matrixRows: number;
  matrixCols: number;
  serpentine: boolean;
  arcRadius: number;    // meters
  arcAngle: number;     // degrees of total sweep
}

export const defaultLayout3D = (): Layout3D => ({
  type: 'line', ledSpacing: 0.0166, // ~60 LEDs/m
  matrixRows: 8, matrixCols: 8, serpentine: true,
  arcRadius: 1, arcAngle: 180,
});

export type OutputProtocol = 'artnet' | 'sacn';

// S5 — a physical output device. Fixtures are assigned to one (controllerId) and
// auto-patched into its universes; Stage resolves each fixture's destination here.
export interface Controller {
  id: string;
  name: string;
  protocol: OutputProtocol;
  ip: string;
  broadcast: boolean;
  priority?: number;     // sACN priority
  startUniverse?: number; // first universe this controller fills (default 0)
}

export interface OutputTarget {
  ip?: string;             // override controller IP (else global AppSettings.artNetIp)
  protocol?: OutputProtocol; // override global protocol
  broadcast?: boolean;     // Art-Net: UDP broadcast; sACN: multicast (239.255.x.x)
  sparse?: boolean;        // skip universes whose data is unchanged since last send
  priority?: number;       // sACN priority (1..200, default 100)
}

export enum SourceType {
  VIDEO = 'VIDEO',
  IMAGE = 'IMAGE',
  CAMERA = 'CAMERA',
  DMX_IN = 'DMX_IN',
  SPOUT = 'SPOUT',
  NDI = 'NDI',           // network video (NDI receive)
  LAYER = 'LAYER',       // a single timeline track (by layerId)
  PROGRAM = 'PROGRAM',   // the whole timeline composited (all contributing layers, z-ordered)
  TRACKING = 'TRACKING', // LiDAR blob positions (by trackingSource)
  MEDIAPIPE = 'MEDIAPIPE', // camera-based pose positions (BlazePose; @artlux/plugin-mediapipe)
  AUGMENTA = 'AUGMENTA', // Augmenta box optical tracking (OSC; @artlux/plugin-augmenta)
  NONE = 'NONE'
}

// A Surface is a rectangular region on the stage carrying one content source.
// Fixtures sample surfaces (see Fixture.surfaceId). EFFECT content is rendered
// in S2; for now it shows nothing.
export interface SurfaceContent {
  // Core source types + 'EFFECT', OR an OPEN plugin-contributed type string. `(string & {})` keeps the
  // union's editor autocomplete for the known values while still accepting any plugin type id. The
  // compositor dispatches unknown types through `contentSourceRegistry` (see contentSource.getDrawable's
  // default branch), so a plugin can introduce a new content type with NO core enum edit. Core enum
  // values (TRACKING, NDI, SPOUT, …) stay in the enum so persisted projects need zero migration.
  type: SourceType | 'EFFECT' | (string & {});
  url?: string;        // VIDEO / IMAGE object URL or file path
  spoutName?: string;  // SPOUT sender name (empty = active sender)
  ndiName?: string;    // NDI source name (empty = first discovered)
  layerId?: string;    // LAYER content: which timeline track to show
  opacity?: number;    // surface opacity 0..1 (default 1) — composite alpha; fadeable for crossfades
  // EFFECT params (S2):
  effectId?: number;
  paletteId?: number;
  speed?: number;
  intensity?: number;
  // TRACKING params (LiDAR blob viz, projection-mappable):
  trackingSource?: string;   // which tracking surface: 'SOL' | 'MUR' | 'SOL_MUR'
  bgLayerId?: string;        // optional timeline layer drawn UNDER the blobs (video + blobs on one surface)
  blobSize?: number;         // marker radius as a fraction of the zone height (0..1)
  showIds?: boolean;         // draw each blob's tracking id
  flipH?: boolean;           // mirror u (left↔right) to match the projector orientation
  flipV?: boolean;           // mirror v (near↔far / up↔down)
  rotate?: number;           // 0 | 90 | 180 | 270 — rotate the tracking frame
  calibration?: boolean;     // overlay zone border + grid + corner labels for alignment
  trail?: boolean;           // comet trail behind each blob (default on)
  trailSeconds?: number;     // trail length, seconds
  // MEDIAPIPE params (camera pose tracking — @artlux/plugin-mediapipe). Reuses the TRACKING fields
  // above (blobSize, showIds, flipH/flipV, rotate, trail, trailSeconds, bgLayerId, opacity) since the
  // viz is the same normalized-position marker set; only the extra pose-skeleton toggle is new.
  poseSkeleton?: boolean;    // draw the BlazePose bone connections between landmarks (default off)
}

// --- Video-layer timeline (NLE) ---
// A layer is a track = an addressable output channel; surfaces/3D planes bind to its id.
// The header flags (muted/solo/locked/enabled) are EDIT-UX only — the playback engine
// (services/timeline.ts) ignores them so playback/compositing is unchanged.
// A layer is either a normal video track or the special 'tracking' lane that holds recorded
// LiDAR blob takes (replayed into the tracking store during playback). Absent kind ⇒ 'video'.
export type LayerKind = 'video' | 'tracking';
export type LayerBlendMode = 'normal' | 'add' | 'screen' | 'multiply';
export interface VideoLayer {
  id: string;
  name: string;
  kind?: LayerKind;      // 'tracking' = LiDAR-blob take lane; undefined/'video' = normal track
  height?: number;       // lane height in px (default LANE_H)
  color?: string;        // hex label color for the track header (default none)
  // muted/solo/enabled gate the timeline PROGRAM composite (SourceType.PROGRAM). A surface bound
  // directly to a single layer (SourceType.LAYER) shows it regardless of these flags.
  muted?: boolean;       // excluded from the program
  solo?: boolean;        // when any layer is soloed, only soloed (non-muted) layers contribute
  locked?: boolean;      // prevents clip edits on this track in the UI
  enabled?: boolean;     // false = excluded from the program; default true
  opacity?: number;      // program composite alpha 0..1 (default 1)
  blendMode?: LayerBlendMode; // program composite blend (default 'normal')
}
// A clip placed on a track. All times are seconds.
export interface VideoClip {
  id: string;
  layerId: string;
  name: string;
  path: string;          // MP4 file path (video) or .lblob take file (tracking) — loaded via IPC
  kind?: 'video' | 'tracking'; // matches the host layer's kind; undefined ⇒ 'video'
  takeId?: string;       // tracking clips: id of the source take in timeline.trackingTakes
  // Generalized content: any surface source type (Image/Camera/DMX-in/Spout/NDI/Effect/Tracking)
  // scheduled on the layer for this clip's span. Absent (or type VIDEO) ⇒ legacy path-based video.
  content?: SurfaceContent;
  start: number;         // timeline position where the clip begins
  duration: number;      // clip length on the timeline
  inPoint: number;       // offset into the source where playback starts (trim)
  sourceDuration?: number; // full length of the source video/take (for trim limits)
  color?: string;        // per-clip tint override (optional)
}
// A clip whose pixels come from a generalized content source (not the legacy video <video>/HAP path).
// Video clips stay path-based even if they also carry content={type:VIDEO,...}.
export const isContentClip = (c: VideoClip): boolean => !!c.content && c.content.type !== SourceType.VIDEO;
// Managed media library types live in shared/ (crosses the IPC boundary on import); re-exported
// here so renderer code imports them from './types' alongside everything else.
export type { AssetType, AssetEntry } from '../../shared/protocol';

// A recorded LiDAR-blob take in the project's take library. The frames live in a sidecar
// `.lblob` file (path); this lightweight ref is what persists in the project + the bin UI.
export interface TrackingTakeRef {
  id: string;
  name: string;
  path: string;          // sidecar .lblob file (resolved absolute on load like clip paths)
  duration: number;      // seconds
  fps?: number;          // nominal capture rate
}
// A point of interest on the timeline ruler.
export interface Marker {
  id: string;
  time: number;          // seconds
  color: string;         // hex
  note?: string;
}

// --- State machine (project-level "Show" graph over scenes) ---
// An always-available, optional finite-state graph. Each state can bind a Scene (recalled on entry)
// and/or run transport actions (play/pause/seek/loop). It lives at PROJECT scope (ProjectData.
// stateMachine), driven by the engine runtime (services/stateMachine.ts) on a standalone wall clock:
// `manual`/`afterDelay` work with the transport stopped, while `atTime`/`onMarker`/`onClipEnd` fire
// when the timeline plays. While `enabled`, it evaluates the current state's outgoing transitions
// each frame, recalls bound scenes (with the transition's fade) and emits transport intents to App.
export type SmActionKind = 'play' | 'pause' | 'stop' | 'seek' | 'setLoop' | 'jumpMarker' | 'recallScene' | 'fireCue';
export interface SmAction {
  kind: SmActionKind;
  seekTo?: number;       // seconds — for 'seek'
  loopOn?: boolean;      // for 'setLoop'
  markerId?: string;     // for 'jumpMarker'
  sceneId?: string;      // for 'recallScene' — Scene.id to recall on state entry
  cueId?: string;        // for 'fireCue' — Cue.id to fire on state entry
}
export type SmTriggerKind =
  | 'manual'             // fired by a UI button / external trigger only
  | 'afterDelay'         // `seconds` after the state was entered
  | 'atTime'             // when the playhead crosses absolute `time`
  | 'onMarker'           // when the playhead crosses marker `markerId`
  | 'onClipEnd'          // when the active clip on `layerId` ends (a gap appears)
  | 'onTimelineEnd';     // when the bound timeline reaches its end (not looping) — auto-advance
export interface SmTrigger {
  kind: SmTriggerKind;
  seconds?: number;      // afterDelay
  time?: number;         // atTime
  markerId?: string;     // onMarker
  layerId?: string;      // onClipEnd
}
export interface SmState {
  id: string;
  name: string;
  x: number;             // node position in the graph editor
  y: number;
  entry: SmAction[];     // actions run when this state is entered
  sceneId?: string;      // scene auto-recalled on entry (1:1 binding — nodes ARE looks)
  lockSec?: number;      // AutomataUI "lock time": dwell before this state's auto/afterDelay transitions fire
  regionId?: string;     // owning Region (visual grouping — see SmRegion)
}
export interface SmTransition {
  id: string;
  from: string;          // SmState.id
  to: string;            // SmState.id
  trigger: SmTrigger;
  fadeSec?: number;      // AutomataUI "transition time": scene crossfade applied on the target state
  c1?: { x: number; y: number }; // cubic-bezier control handle 1 (canvas coords) — curved edge
  c2?: { x: number; y: number }; // cubic-bezier control handle 2 (canvas coords)
}
// A resizable group box ("the big OR") that organizes related states. Visual/organizational only —
// states inside carry its id in `regionId` and move/resize with it.
export interface SmRegion {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
}
export interface StateMachine {
  enabled: boolean;
  states: SmState[];
  transitions: SmTransition[];
  initialStateId: string | null;
  regions?: SmRegion[];
}
export const defaultStateMachine = (): StateMachine => ({
  enabled: false, states: [], transitions: [], initialStateId: null, regions: [],
});

// --- Automation (Wave 3, P4) ---
// A keyframe curve over the PLAYHEAD. Lanes ride the Timeline exactly as clips do — which means they
// come along for free wherever a Timeline goes: the shared global timeline (ProjectData.timeline) and
// each scene's own (scene.timeline). The engine evaluates the GLOBAL timeline's lanes as a BASE LAYER
// underneath the active scene's, shadowed per targetPath, so a scene can override one curve without
// disturbing the rest of the show's automation.
export type CurveKind = 'linear' | 'hold' | 'bezier';
// One breakpoint. `t` is TIMELINE seconds (never clip-relative, and never clamped to `duration` — the
// timeline is unbounded). `v` is in the TARGET'S NATIVE UNITS: Hz, dB, linear gain, metres — the very
// number the authoring slider writes, so a keyframe means exactly what the fader meant. `curve` shapes
// the segment STARTING at this keyframe.
export interface Keyframe {
  t: number;
  v: number;
  curve?: CurveKind;                                      // default 'linear'
  cx1?: number; cy1?: number; cx2?: number; cy2?: number; // bezier handles, normalised into the segment's unit box
}
export interface AutomationLane {
  id: string;
  targetPath: string;     // dot-path; the HEAD names the namespace, and only its owner parses the rest
  enabled?: boolean;      // default true. false ⇒ authored but inert, and the path returns to manual control
  keyframes: Keyframe[];  // INVARIANT: sorted ascending by t (normalizeTimeline enforces it)
  height?: number;        // lane height in px
  color?: string;
}

export interface Timeline {
  layers: VideoLayer[];
  clips: VideoClip[];
  duration: number;      // the "Length" field — the timeline's END (see timelineEnd); an outPoint overrides it
  fps?: number;          // frame rate for HH:MM:SS:FF timecode (default 30)
  markers?: Marker[];    // ruler markers
  inPoint?: number | null;  // timeline range start (export/loop region) — NOT clip trim
  outPoint?: number | null; // timeline range end
  loop?: boolean;        // when true, playback wraps over [timelineStart, timelineEnd); else it pauses at the end
  trackingTakes?: TrackingTakeRef[]; // recorded LiDAR-blob take library (drag onto a tracking lane)
  automation?: AutomationLane[];     // keyframe curves over the playhead (P4)
  /** @deprecated moved to project scope (ProjectData.stateMachine); kept read-only for migration. */
  stateMachine?: StateMachine;
}
export const defaultTimeline = (): Timeline => ({
  layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
  loop: false, trackingTakes: [], automation: [],
});

// The timeline's playable range. `duration` (the "Length" field) IS the end — as of Wave A it once
// again bounds playback, reverting the v0.12.0 unbounded clock deliberately (see docs/TIMELINE.md).
// An explicit out-point overrides it; an explicit in-point moves the start.
//
// TRUST NOTHING. These two are the ONLY bound the engine clock has: it takes `a = timelineStart`,
// `b = timelineEnd` and tests `t < a` / `t >= b`. A non-finite bound makes BOTH tests false, so a
// project carrying `duration: NaN` (or `null`, or the string `"10"`, or `outPoint: Infinity` — a
// hand-edit, a bad import, a future migration) would silently restore the unbounded clock and
// silently stop Loop from doing anything, with no error anywhere. Coerce instead: a junk duration
// falls back to defaultTimeline()'s 60, and a junk in/out-point is treated as ABSENT.
const finiteNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const FALLBACK_DURATION = 60; // == defaultTimeline().duration

export const timelineStart = (t: Timeline): number => Math.max(0, finiteNum(t.inPoint) ?? 0);
// The "Length" field, coerced. NOT the playable end — an out-point overrides Length (use timelineEnd).
// This is the guarded reader for anything that genuinely wants the document's Length (status readouts).
export const timelineDuration = (t: Timeline): number => finiteNum(t.duration) ?? FALLBACK_DURATION;
export const timelineEnd = (t: Timeline): number => {
  const start = timelineStart(t);
  const out = finiteNum(t.outPoint);
  // A degenerate region (out <= in) is ignored rather than obeyed — obeying it would wedge the
  // transport at a single instant with no way to escape from the UI.
  if (out != null && out > start) return out;
  return Math.max(start + 0.1, timelineDuration(t));
};

// Coerce a persisted automation array: drop junk, default the curve, and SORT — the sampler's cursor
// assumes ascending `t`, and a hand-edited file must not be able to corrupt it.
const normalizeAutomation = (a: unknown): AutomationLane[] => {
  if (!Array.isArray(a)) return [];
  return (a as Partial<AutomationLane>[]).flatMap(l => {
    if (!l || typeof l.id !== 'string' || typeof l.targetPath !== 'string') return [];
    const keyframes = (Array.isArray(l.keyframes) ? l.keyframes : [])
      .filter((k): k is Keyframe => !!k && Number.isFinite(k.t) && Number.isFinite(k.v))
      .map(k => ({ ...k, curve: k.curve ?? 'linear' as CurveKind }))
      .sort((x, y) => x.t - y.t);
    return [{ ...l, enabled: l.enabled ?? true, keyframes } as AutomationLane];
  });
};

// Fill defaults for fields added after a project was saved, so old projects load cleanly.
// Top-level fields would migrate via the spread in App's loader, but per-array fields
// (layer/clip) need explicit defaulting — done here in one place.
export const normalizeTimeline = (t: Partial<Timeline> | null | undefined): Timeline => {
  const base = defaultTimeline();
  // NB: this used to bail on `!Array.isArray(t.layers)` and return an EMPTY timeline — which silently
  // discarded everything else on it. An audio-only scene (automation curves, zero video layers) is a
  // perfectly ordinary thing to author, and it would have lost all its lanes on load, once, for good.
  // A missing `layers` is defaulted below like every other array instead.
  if (!t) return base;
  const { stateMachine: _legacySm, ...rest } = t; // legacy field migrated to project scope in App's loader
  // Coerce `clips` the same way normalizeAutomation coerces lanes: a present-but-wrong-shaped
  // value (e.g. `{}` from a corrupt save — App.tsx's `segments` coercion documents this exact
  // corruption class actually occurring, from a pre-fix cue write) must not reach the `.map()`
  // in the duration computation below, and a null/undefined slot inside an otherwise-valid array
  // (a hand edit, a partially-written save) must not either.
  // The filtered array is also what gets RETURNED as Timeline.clips — downstream code (services/
  // timeline.ts, components/timeline/Timeline.tsx, services/assetLibrary.ts, ...) iterates clips
  // and reads their fields unguarded, so junk entries must be dropped here, once, not chased later.
  const clips: VideoClip[] = (Array.isArray(t.clips) ? t.clips : []).filter(
    (c): c is VideoClip => !!c && typeof c === 'object',
  );
  return {
    ...base,
    ...rest,
    layers: Array.isArray(t.layers) ? t.layers.map(l => ({ enabled: true, ...l })) : [],
    clips,
    trackingTakes: t.trackingTakes ?? [],
    markers: t.markers ?? [],
    inPoint: t.inPoint ?? null,
    outPoint: t.outPoint ?? null,
    fps: t.fps ?? base.fps,
    loop: t.loop ?? false,
    automation: normalizeAutomation(t.automation),
    // BACK-COMPAT (Wave A). `duration` used to be a hint that never bounded playback, so old projects
    // legitimately hold clips past it. Now that it IS the end, obeying it blindly would silently
    // truncate those shows. Raise it once, at load, to cover the content. Never lower it — a
    // deliberately long Length (trailing silence, a hold) is a legitimate authoring choice.
    // Guarded: duration/clip fields/outPoint can each independently be junk (NaN, a string, Infinity)
    // on a hand-edited or malformed project — finiteNum keeps one bad value from poisoning the max().
    duration: Math.max(
      finiteNum(t.duration) ?? base.duration,
      // `c?.` is defense in depth: `clips` is already filtered to objects above, but a bad
      // element shape (e.g. `start`/`duration` themselves missing or non-finite) must still
      // resolve to 0 rather than throw or poison the max() with NaN.
      ...clips.map(c => (finiteNum(c?.start) ?? 0) + (finiteNum(c?.duration) ?? 0)),
      finiteNum(t.outPoint) ?? 0,
    ),
  };
};

// --- Audio subsystem (Wave 3) ---
// The native JUCE engine (plugins/audio + native/audio-engine) renders these; per doctrine the
// PERSISTED types stay core while behaviour lives in the plugin. The GLOBAL audio bed
// (ProjectData.audio) survives scene swaps and rides the main transport playhead; per-scene
// one-shots and scene/state binding arrive later. Everything here is additive + normalize-defaulted,
// so old projects (no `audio`) load unchanged.

// A source position in listener-relative metres (listener at origin, +z forward). Encoded to
// B-format by the ambisonic bus; absent ⇒ the clip routes straight to its bus (non-spatial).
export interface AudioSpatial {
  x: number;
  y: number;
  z: number;
  order?: number;        // ambisonic-order override for this source (default: project/device setting)
}
export type AudioEffectType = 'gain' | 'filter' | 'reverb' | 'delay' | 'compressor';
// One node in an effect chain.
//
// The two maps are split by AUTOMATABILITY, not by convenience:
//   · params — CONTINUOUS values (filter.cutoff, reverb.wet). Each is a fadeable/automatable leaf,
//     addressed by the dot-path grammar (audio.<busId>.effects.<i>.<param>) in P4/P5.
//   · opts   — DISCRETE choices (filter.mode = 'lowpass'|'highpass'|'bandpass'). Strings ON PURPOSE:
//     the fade engine interpolates `number` from→to, so a mode living in `params` would eventually be
//     handed 0.37 by a scene transition. Typing it as a string makes that unrepresentable rather than
//     merely discouraged.
export interface AudioEffect {
  id: string;
  type: AudioEffectType;
  bypass?: boolean;
  params: Record<string, number>;
  opts?: Record<string, string>;
}
// A placed audio clip. All times are seconds on the timeline (start/duration) or into the source (inPoint).
export interface AudioClip {
  id: string;
  trackId: string;         // owning AudioTrack
  name: string;
  path: string;            // audio file (absolute in memory, relative on disk — like every asset path)
  start: number;           // timeline position where the clip begins
  duration: number;        // clip length on the timeline
  inPoint: number;         // offset into the source where playback starts (trim)
  sourceDuration?: number; // full length of the source (for trim limits)
  gain?: number;           // linear gain, default 1
  mute?: boolean;
  fadeIn?: number;         // fade-in length (s)
  fadeOut?: number;        // fade-out length (s)
  spatial?: AudioSpatial;  // absent ⇒ non-spatial
  effects?: AudioEffect[]; // insert chain on this source, applied BEFORE spatialisation (see AudioBus)
}
// A logical audio track (a lane of clips) routed to an output bus.
export interface AudioTrack {
  id: string;
  name: string;
  busId?: string;          // output bus (default: master)
  gain?: number;           // track gain, default 1
  mute?: boolean;
  solo?: boolean;
  color?: string;          // hex label color
}
// A mix bus: gain + an effect chain, optionally sent to a parent bus.
//
// WHERE EFFECTS SIT. A spatial source is a point in an ambisonic field, so it cannot be summed into a
// bus before it is placed — the encoder needs each source's signal on its own. Effects therefore live
// at two scopes, and only two:
//   · AudioClip.effects — an INSERT on the source, applied before it is encoded ("this voice is in a
//     small room"). This is the object-audio convention: inserts belong to the object.
//   · AudioBus.effects on MASTER_BUS_ID — applied to the finished N-channel output, after the field has
//     been decoded to headphones or speakers ("protect the rig, tame the room"). Master is the only bus
//     that exists today; per-bus summing buses arrive with sends.
export const MASTER_BUS_ID = 'master';
export interface AudioBus {
  id: string;
  name: string;
  gain?: number;           // default 1
  effects?: AudioEffect[]; // per-bus effect chain
  sendTo?: string;         // parent bus id for a send (default: master)
}
// The master bus, or a default if the project has never had one (buses start empty — a project only
// materialises master once you touch its gain or add an effect).
export const masterBus = (mix: AudioMix): AudioBus =>
  mix.buses.find((b) => b.id === MASTER_BUS_ID) ?? { id: MASTER_BUS_ID, name: 'Master', gain: 1, effects: [] };
// The global audio bed, persisted opaquely on ProjectData.audio.
export interface AudioMix {
  tracks: AudioTrack[];
  clips: AudioClip[];
  buses: AudioBus[];
}
export const defaultAudioMix = (): AudioMix => ({ tracks: [], clips: [], buses: [] });
// Fill defaults for old/partial project data (mirrors normalizeTimeline). Never throws; a missing
// or malformed `audio` yields an empty bed.
export const normalizeAudioMix = (a: Partial<AudioMix> | null | undefined): AudioMix => {
  if (!a || typeof a !== 'object') return defaultAudioMix();
  return {
    tracks: Array.isArray(a.tracks) ? a.tracks : [],
    clips: Array.isArray(a.clips) ? a.clips : [],
    buses: Array.isArray(a.buses) ? a.buses : [],
  };
};

// Normalize a persisted/partial state machine into a complete one (fills new fields on old saves).
export const normalizeStateMachine = (sm: Partial<StateMachine> | null | undefined): StateMachine => {
  if (!sm || !Array.isArray(sm.states)) return defaultStateMachine();
  return {
    enabled: !!sm.enabled,
    states: sm.states ?? [],
    transitions: sm.transitions ?? [],
    initialStateId: sm.initialStateId ?? null,
    regions: sm.regions ?? [],
  };
};

export interface Surface {
  id: string;
  name: string;
  // Normalized rect on the global stage canvas (0..1).
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;  // degrees
  zIndex: number;    // composite order (higher = on top)
  content: SurfaceContent;
}

export interface AppSettings {
  artNetIp: string;
  artNetPort: number;
  outputEnabled: boolean; // master enable for native output
  broadcast: boolean;     // broadcast vs unicast to artNetIp
  gamma: number;          // output gamma correction (1.0 = off)
  protocol: OutputProtocol; // default output protocol (per-fixture can override)
  fps: number;            // native engine output pacing rate
  keepAlive: boolean;     // re-send last frame on pacer timeout
  artNetSync: boolean;    // emit ArtSync (OpSync 0x5200) after each frame
  // OSC receive (external control + LiDAR blob tracking)
  oscEnabled: boolean;    // bind the OSC UDP listener
  oscListenPort: number;  // UDP port (installation default: 10000)
  oscListenAddress: string; // bind to a specific local NIC IP (this machine's address); '' = all interfaces
  oscControlPrefix: string; // namespace for external control messages, e.g. '/artlux'
  // Help panel
  helpLang: 'en' | 'fr'; // language for the bilingual Help panel + contextual hints
  // Video decode
  mp4WebCodecs?: boolean; // decode .mp4/.m4v via the WebCodecs plugin (frame-accurate; no HW-session cap)
                          // instead of the default <video> element. Off by default → unchanged behaviour.
  // Patch policy
  reserveLockedRanges?: boolean; // auto-patch packs auto fixtures AROUND locked ranges instead of
                                 // through them. Off by default → today's addresses are byte-stable;
                                 // turning it on re-addresses auto fixtures on the next patch (opt-in).
  // Namespace for plugin-private settings that don't warrant a core field. A plugin keys by its id
  // (`settings.plugins?.['my-plugin']`) and owns the shape. Cross-app persisted settings that the host
  // also reads (like mp4WebCodecs) stay top-level core fields; this is for genuinely plugin-local prefs.
  plugins?: Record<string, unknown>;
}

export enum ViewMode {
  MAPPING = 'MAPPING',
  MONITORING = 'MONITORING',
  SIMULATOR_3D = 'SIMULATOR_3D'
}

// MadMapper-style top-level modules (drive the left panel + center stage).
export enum Module {
  MEDIA = 'MEDIA',       // content source + effects
  MAP = 'MAP',           // 2D placement on the stage
  FIXTURES = 'FIXTURES', // DMX patch (universe/addr/color/segments/routing)
  THREE_D = 'THREE_D',   // 3D simulator
}

// Bottom dock tabs.
export enum DockTab {
  MONITOR = 'MONITOR',
  FIXTURE_EDITOR = 'FIXTURE_EDITOR',
  TIMELINE = 'TIMELINE',
  SCENES = 'SCENES',
  PERF = 'PERF',
}

// Phase I — named selection set for batch operations.
export interface FixtureGroup {
  id: string;
  name: string;
  fixtureIds: string[];
}

// A named snapshot of the look (instant recall). Captures the visible state — surfaces,
// fixtures, brightness, groups, 3D scene and projector outputs — and MAY now own its own
// `timeline` (per-state decoupled NLE): when present, recalling the scene warm-swaps the
// playback engine to it; when absent the scene falls back to the shared ProjectData.timeline.
// Recall snaps instantly in v1; `fadeSec` is stored for a future crossfade engine. Every field
// beyond fixtures/globalBrightness is optional so older minimal scenes still load.
export interface Scene {
  id: string;
  name: string;
  fadeSec?: number;            // stored, NOT applied in v1 (snap recall)
  surfaces?: Surface[];
  fixtures: Fixture[];         // colorData stripped (it's the live DMX frame)
  globalBrightness: number;
  groups?: FixtureGroup[];
  scene3D?: Scene3D;
  projectorOutputs?: ProjectorOutput[];
  timeline?: Timeline;         // per-state timeline; absent → uses the shared global timeline
  accent?: string;             // stable identity colour (node/pill/border/strip/cell) — see accentPalette
}

// --- Granular cues (MadMapper-style cue banks) ---
// A Scene is a whole-look snapshot; a Cue stores an arbitrary SUBSET of parameters (object ->
// param -> value by dot-path, see services/paramPath) so firing it patches only those and composes
// with other cues. Cues live in a grid: row 0 holds Scenes (sceneCells), rows 1+ hold Cues.
// Firing a column fires its row-0 scene if present, else every cue in the column (bottom-to-top).
export type CueTransition = 'linear' | 'smooth' | 'damper' | 'none';
export interface CueEntry {
  path: string;                       // e.g. 'globalBrightness' | 'surfaces.<id>.content.opacity'
  value: number | string | boolean | null;
  transition?: CueTransition;         // per-entry override (else the cue's)
  fadeSec?: number;                   // per-entry override (else the cue's)
}
export interface Cue {
  id: string;
  name: string;
  row: number;                        // grid row (>= 1; row 0 is reserved for scenes)
  col: number;                        // grid column (0-based)
  entries: CueEntry[];
  fadeSec: number;                    // default transition time for entries
  transition: CueTransition;          // default transition type for entries
  color?: string;                     // optional cell tint
  restartMedia?: boolean;             // re-seek media surfaces to 0 when fired
}
export interface CueBank {
  id: string;
  name: string;
  rows: number;                       // grid size (auto-grows in the UI)
  cols: number;
  cues: Cue[];                        // rows 1+
  sceneCells: { col: number; sceneId: string }[]; // row 0 → existing Scene ids
}
export const defaultCueBank = (id: string, name = 'Bank 1'): CueBank => ({
  id, name, rows: 8, cols: 16, cues: [], sceneCells: [],
});

// S4 — a saved, reusable fixture definition (LED structure only; no placement,
// patch, or surface link). Persisted to userData so the library spans projects.
export interface FixtureTemplate {
  id: string;
  name: string;
  ledCount: number;
  shape?: LedShape;
  matrixWidth?: number;
  matrixHeight?: number;
  serpentine?: boolean;
  colorOrder?: ColorOrder;
  rgbwMode?: RGBWMode;
  channelsPerPixel?: 3 | 4;
}