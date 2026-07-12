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
  // A timeline's OWN audio — audio that plays with THIS timeline's picture and restarts when it does.
  //
  // NOT a second bed. The two audio containers differ by CLOCK, and the clock follows the CONTAINER,
  // never the timeline it happens to be drawn next to:
  //   · ProjectData.audio  — THE BED. One per project. Rides the SHOW clock. Survives a scene recall.
  //   · Timeline.audio     — this document's audio. Rides the PLAYHEAD. Restarts with its timeline.
  // It exists on the GLOBAL timeline too (a show can legitimately use both: a bed that never stops, plus
  // global-timeline audio that restarts whenever the global timeline does). No `buses`: AudioBus is
  // project-global (there is ONE output chain — see "WHERE EFFECTS SIT" below).
  //
  // An audio clip does NOT extend the Length — see the duration raise in normalizeTimeline.
  audio?: TimelineAudio;
  // WAVE A MIGRATION MARKER — "this document's `duration` was authored against a BOUNDED clock".
  //
  // Before Wave A, `duration` was an ignored hint: playback ran on past it, so an old project can
  // legitimately hold clips that overrun its Length. Now that Length IS the end (timelineEnd), obeying
  // an old file's Length blindly would silently truncate those shows — hence the one-shot raise in
  // normalizeTimeline. But that raise is PERSISTED, so without a way to tell "old file" from "new
  // file" it also runs on every subsequent load and destroys a deliberately SHORT Length (a Length of
  // 8 over a 20 s ambient bed comes back as 20): load(save(x)).duration !== x.duration, and "Length
  // shorter than the content" becomes unauthorable forever.
  //
  // This flag is that discriminator. ABSENT ⇒ pre-Wave-A (or hand-written): raise Length to cover the
  // content, once. PRESENT ⇒ the Length is intentional: never touch it. normalizeTimeline stamps it on
  // the way out and defaultTimeline() mints it, so every timeline this build writes carries it and the
  // raise can never run twice on the same document.
  //
  // ADDITIVE on purpose (rather than gating on ProjectData.version, which nothing reads): an older
  // ArtLux build simply ignores the field — and would re-raise on load, which is exactly its own
  // pre-existing behaviour, not a new failure.
  boundedDuration?: boolean;
  /** @deprecated moved to project scope (ProjectData.stateMachine); kept read-only for migration. */
  stateMachine?: StateMachine;
}
export const defaultTimeline = (): Timeline => ({
  layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
  loop: false, trackingTakes: [], automation: [], audio: { tracks: [], clips: [] }, boundedDuration: true,
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
// finiteNum's boolean twin, for the optional flags (mute/solo) whose consumers all test TRUTHINESS.
// A real boolean passes through byte-for-byte — an authored `false` stays `false`, so the round-trip is
// exact — and anything else (`"false"`, `1`, `{}`, `null`) becomes ABSENT, which every call site reads
// as "off". That is the safe direction: the alternative is a junk string, which is truthy, turning a
// flag ON by itself. See sanitizeAudioTrack for what a spuriously-on `solo` does to a show.
const boolOrAbsent = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const FALLBACK_DURATION = 60; // == defaultTimeline().duration

// The "Length" field, coerced. NOT the playable end — an out-point overrides Length (use timelineEnd).
// This is the guarded reader for anything that genuinely wants the document's Length (status readouts).
export const timelineDuration = (t: Timeline): number => finiteNum(t.duration) ?? FALLBACK_DURATION;

// The playable range's START. A DEGENERATE IN-POINT IS IGNORED, symmetric with the degenerate-out
// guard in timelineEnd below — and for exactly the same reason.
//
// `End` seeks to the CONTENT end (which may lie past Length — scrubbing past the end is deliberately
// supported), and `I` then sets the in-point there. On a Length-60 timeline that leaves inPoint = 70,
// and timelineEnd's `Math.max(start + 0.1, duration)` floor turns the playable range into [70, 70.1):
// Play advances three frames, the end-stop parks, App pauses; Play again re-seeks to 70 and repeats
// forever. The floor exists SPECIFICALLY to stop a degenerate OUT-point wedging the transport that
// way; without this it created the identical wedge for the IN-point case it never checked.
//
// An in-point past Length is only degenerate when nothing extends the end past it. An explicit
// out-point DOES (an out-point overrides Length), so `in: 70, out: 90` on a Length-60 document is a
// perfectly good region and is honoured — only an in-point with no out-point beyond it, sitting at or
// past Length, is ignored (treated as ABSENT, like any other junk value). Nothing is destroyed: the
// authored value stays in the document and on the ruler handle, so it can be dragged back.
export const timelineStart = (t: Timeline): number => {
  const start = Math.max(0, finiteNum(t.inPoint) ?? 0);
  const out = finiteNum(t.outPoint);
  if (out != null && out > start) return start; // a real region — the in-point bounds it
  return start < timelineDuration(t) ? start : 0;
};
export const timelineEnd = (t: Timeline): number => {
  const start = timelineStart(t);
  const out = finiteNum(t.outPoint);
  // A degenerate region (out <= in) is ignored rather than obeyed — obeying it would wedge the
  // transport at a single instant with no way to escape from the UI.
  if (out != null && out > start) return out;
  return Math.max(start + 0.1, timelineDuration(t));
};
// Does the engine actually HONOUR an in/out region on this document? The Loop tooltip and the ruler's
// shaded band used to require BOTH points, but the clock honours either alone (start = inPoint ?? 0,
// end = outPoint ?? Length) — and one click of the Set In button puts you there. Asks the guarded
// readers rather than the raw fields, so a degenerate in/out point (ignored above) doesn't claim a
// region that does not exist.
export const hasTimelineRegion = (t: Timeline): boolean => {
  const start = timelineStart(t);
  const out = finiteNum(t.outPoint);
  return start > 0 || (out != null && out > start);
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

// Coerce a persisted markers array the same way normalizeAutomation coerces lanes: a
// present-but-wrong-shaped value (`"x"`, `{}`, a null slot) must not reach TimelineRuler's
// unguarded `{markers.map(...)}` in the always-mounted Timeline panel. `id` is checked as a string
// and `time` as a finite number — the fields TimelineRuler actually keys/positions off of —
// mirroring normalizeAutomation's `id`/`targetPath` check.
//
// COERCE, DO NOT DROP (the rule stated a few lines below, for clips). `color` is COSMETIC: it picks
// the marker triangle's fill and nothing else. Requiring it as a string, and dropping the whole entry
// when it is missing, threw away the `id` and the `time` — the user's actual data — over a paint
// value we can trivially default. normalizeAutomation already shows the shape (`curve: k.curve ??
// 'linear'`). Default it to the same colour addMarker mints, so a hand-authored / tool-generated
// project (exactly this sanitiser's stated threat model) loads its markers instead of losing them.
const MARKER_COLOR = '#f5a623'; // == the colour Timeline.addMarker() assigns
const normalizeMarkers = (m: unknown): Marker[] => {
  if (!Array.isArray(m)) return [];
  return (m as Partial<Marker>[]).flatMap(x => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
    if (typeof x.id !== 'string' || !Number.isFinite(x.time)) return [];
    return [{ ...x, id: x.id, time: x.time as number, color: typeof x.color === 'string' ? x.color : MARKER_COLOR }];
  });
};

// Coerce a persisted trackingTakes array the same way. Consumers (TakesBin, assetLibrary) iterate
// it unguarded. `id`/`path` must be strings and `duration` finite — assetLibrary/TakesBin use those
// directly (to key, resolve and size the take) without their own guard.
//
// COERCE, DO NOT DROP, again: `name` is a LABEL. Dropping a take because it has no name threw away
// its `path` and `duration` — i.e. the recording — over a caption. Default it to the file's basename,
// which is what the user would have called it anyway.
const takeName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() || 'Take';
const normalizeTrackingTakes = (tt: unknown): TrackingTakeRef[] => {
  if (!Array.isArray(tt)) return [];
  return (tt as Partial<TrackingTakeRef>[]).flatMap(x => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return [];
    if (typeof x.id !== 'string' || typeof x.path !== 'string' || !Number.isFinite(x.duration)) return [];
    return [{ ...x, id: x.id, path: x.path, duration: x.duration as number, name: typeof x.name === 'string' ? x.name : takeName(x.path) }];
  });
};

// Sanitise a clip's numeric fields so junk (NaN, a string, Infinity) can never escape
// normalizeTimeline. Coerce, do not drop: a clip with a bad number is recoverable user data (the
// user can see and fix a zero-duration clip); silently deleting it is not. `start`/`duration`
// feed Timeline.tsx's `Math.max(dur, ..., ...clips.map(c => c.start + c.duration))` unguarded —
// one NaN there poisons contentEnd/viewEnd/the scroll-area CSS width and fmtTimecode renders the
// literal string "NaN:NaN:NaN:NaN". `inPoint` gets the same treatment: it feeds the same file's
// trim-limit arithmetic (`(c.sourceDuration ?? Infinity) - c.inPoint`) just as unguarded. A
// non-finite `start`/`duration`/`inPoint` becomes 0 — inert and visible, not corrupt.
// `sourceDuration` is different: it's OPTIONAL and "absent" already means "no cap" at its one call
// site (`c.sourceDuration ?? Infinity`). Note `??` does NOT catch a present-but-NaN value, so
// without this a junk sourceDuration would compute `NaN - inPoint = NaN` there. Zeroing it would
// fabricate a cap of `-inPoint` (worse than no cap), so a non-finite sourceDuration is dropped
// back to `undefined` — i.e. treated as absent — instead of coerced to 0.
const sanitizeClip = (c: VideoClip): VideoClip => ({
  ...c,
  start: finiteNum(c.start) ?? 0,
  duration: finiteNum(c.duration) ?? 0,
  inPoint: finiteNum(c.inPoint) ?? 0,
  sourceDuration: finiteNum(c.sourceDuration) ?? undefined,
});

// --- Audio coercion (Wave B). Declared HERE, above normalizeTimeline, rather than down in the audio
// section next to the types they coerce: normalizeTimeline calls normalizeTimelineAudio, and a `const`
// arrow is NOT hoisted. It would work either way (normalizeTimeline only runs long after this module's
// body has evaluated), but "it would work" is not a property worth betting a WHITE SCREEN ON LOAD on —
// a single future module-scope call would turn it into a TDZ ReferenceError inside the one function
// that is documented to never throw. The interfaces they mention (AudioClip/AudioTrack/TimelineAudio)
// are declared further down and are hoisted; only the VALUES need to be in order. ---

// The audio twin of sanitizeClip — and the guard the BED has been missing since Wave 3.
//
// COERCE, DO NOT DROP, same as video: a clip with a bad number is recoverable user data (you can see
// and fix a zero-duration clip); silently deleting it is not. start/duration/inPoint feed the lane's
// width arithmetic (`Math.max(..., ...clips.map(c => c.start + c.duration))`) and the driver's window
// test (`playhead >= clip.start && playhead < clip.start + clip.duration`) completely unguarded — one
// NaN there poisons contentEnd, the scroll-area CSS width, and every audibility decision.
// `sourceDuration` is OPTIONAL and "absent" already means "no cap" at its call sites, and `??` does
// NOT catch a present-but-NaN value — so a non-finite one is DROPPED back to undefined rather than
// coerced to 0 (zeroing it would fabricate a trim cap of `-inPoint`, which is worse than no cap).
// gain/fadeIn/fadeOut get the same treatment: a non-finite fade is ABSENT, not a NaN gain ramp in the
// driver.
// `mute` is a BOOLEAN with the same hole one type over: the driver's audibility test is truthy
// (`!clip.mute && !trackOf(clip)?.mute` in plugins/audio's renderer), so a hand-edited/bad-import
// `"mute": "false"` — a non-empty STRING — is truthy and SILENCES the clip, with no error anywhere.
// boolOrAbsent is the boolean twin of finiteNum: a real boolean survives byte-for-byte (an authored
// `false` stays `false`, so load(save(x)) === x), and anything else becomes ABSENT, which reads as
// "not muted" at every call site. Coerce to absent, do not drop the clip.
export const sanitizeAudioClip = (c: AudioClip): AudioClip => ({
  ...c,
  start: finiteNum(c.start) ?? 0,
  duration: finiteNum(c.duration) ?? 0,
  inPoint: finiteNum(c.inPoint) ?? 0,
  sourceDuration: finiteNum(c.sourceDuration) ?? undefined,
  gain: finiteNum(c.gain) ?? undefined,
  mute: boolOrAbsent(c.mute),
  fadeIn: finiteNum(c.fadeIn) ?? undefined,
  fadeOut: finiteNum(c.fadeOut) ?? undefined,
});

// A TRACK's numbers need the same guard as a clip's — and this is not theoretical. The driver
// multiplies the track gain in UNGUARDED (`... ?? trackOf(clip)?.gain ?? 1` in plugins/audio's
// renderer), and `??` does NOT catch a present-but-NaN value, which is the exact hole sanitizeClip's
// own comment above was written about. A hand-edited/bad-import `"gain": "x"` on a track ⇒
// `setClipGain(id, NaN)` for every clip on it, and a gutter's `<input type="range" value={NaN}>` goes
// uncontrolled. Coerce, do not drop: `undefined` means "1" at every call site, so a junk gain becomes
// absent rather than a silent zero.
//
// `mute`/`solo` need it just as badly, and solo is the WORST of the three because it is INVERTED: the
// rule is "if ANY track is soloed, every non-soloed track is silent" (the same shape as the video
// layers' anySolo in services/timeline.ts), so ONE junk truthy value — `"solo": "false"`, a non-empty
// string — on a single unused track SILENCES THE WHOLE BED, in a venue, with nothing logged. `mute` is
// already live on that path today (plugins/audio's renderer tests `!trackOf(clip)?.mute` truthily).
// boolOrAbsent keeps a real boolean byte-for-byte (round-trip) and turns anything else into ABSENT,
// which is the "off" reading at every call site.
export const sanitizeAudioTrack = (t: AudioTrack): AudioTrack => ({
  ...t,
  gain: finiteNum(t.gain) ?? undefined,
  mute: boolOrAbsent(t.mute),
  solo: boolOrAbsent(t.solo),
});

// Coerce a persisted audio container (Timeline.audio, or an AudioMix's tracks+clips). Never throws; a
// missing/garbage value yields an empty container. Same filter shape as normalizeTimeline's clips
// guard: exclude null/undefined slots and bare ARRAYS (`typeof [] === 'object'`, so they used to sail
// through a naive `typeof c === 'object'` test), but ACCEPT `{}` — sanitizeAudioClip coerces its
// numbers, so it can no longer poison anything, and dropping it would fight the coerce-don't-drop rule.
export const normalizeTimelineAudio = (a: unknown): TimelineAudio => {
  const o = a as Partial<TimelineAudio> | null | undefined;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { tracks: [], clips: [] };
  return {
    tracks: (Array.isArray(o.tracks) ? o.tracks : [])
      .filter((t): t is AudioTrack => !!t && typeof t === 'object' && !Array.isArray(t))
      .map(sanitizeAudioTrack),
    clips: (Array.isArray(o.clips) ? o.clips : [])
      .filter((c): c is AudioClip => !!c && typeof c === 'object' && !Array.isArray(c))
      .map(sanitizeAudioClip),
  };
};

// Guarded readers — every consumer goes through these, so `audio` being absent (an old project) or junk
// (a live in-memory Timeline that never passed through normalizeTimeline) is handled in ONE place
// instead of at each of a dozen `t.audio?.clips ?? []` sites that will drift.
export const timelineAudioClips = (t: Timeline): AudioClip[] => (Array.isArray(t.audio?.clips) ? t.audio!.clips : []);
export const timelineAudioTracks = (t: Timeline): AudioTrack[] => (Array.isArray(t.audio?.tracks) ? t.audio!.tracks : []);

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
  // Shape check: tightened only to exclude a bare array (`typeof [] === 'object'`, so it used to
  // pass `!!c && typeof c === 'object'`) — that's the concrete hole the review named. `{}` is
  // still accepted deliberately: once sanitizeClip below coerces its numeric fields, `{}` can no
  // longer poison the Math.max() the way a NaN duration could, so excluding it would only be
  // gold-plating, and it would fight the "coerce, don't drop" rule just below — a clip object
  // whose only problem is a bad/missing number is recoverable user data and must survive, not be
  // silently deleted for the same reason. id/layerId are NOT required here for that reason: an
  // id-less or layerId-less clip is exactly the `{start: 5, duration: NaN}` shape this fix targets
  // (a bad-but-object-shaped clip), and requiring them would drop it instead of coercing it.
  // Numeric fields are sanitised by sanitizeClip below; no other field is validated here.
  // The filtered array is also what gets RETURNED as Timeline.clips — downstream code (services/
  // timeline.ts, components/timeline/Timeline.tsx, services/assetLibrary.ts, ...) iterates clips
  // and reads their fields unguarded, so junk entries must be dropped here, once, not chased later.
  const clips: VideoClip[] = (Array.isArray(t.clips) ? t.clips : [])
    .filter((c): c is VideoClip => !!c && typeof c === 'object' && !Array.isArray(c))
    .map(sanitizeClip);
  return {
    ...base,
    ...rest,
    layers: Array.isArray(t.layers) ? t.layers.map(l => ({ enabled: true, ...l })) : [],
    clips,
    trackingTakes: normalizeTrackingTakes(t.trackingTakes),
    markers: normalizeMarkers(t.markers),
    // ⚠ AFTER the spread, like every other array: `...rest` above would otherwise pass a hand-edited
    // `"audio": 5` or `{"clips": null}` straight into the lane renderer and the audio driver, both of
    // which iterate it unguarded. (Wave B — this timeline's OWN audio, not the bed.)
    audio: normalizeTimelineAudio(t.audio),
    // Guarded like every other number that reaches arithmetic. `??` alone only substitutes null/
    // undefined, so `{"outPoint": 1e400}` (valid JSON — it overflows to Infinity on parse) or
    // `{"fps": "abc"}` sailed straight through into Timeline.tsx's `Math.max(dur, outPoint, …)` and
    // `fmtTimecode(playhead, fps)`, painting the timecode readout as literally "Infinity:NaN:NaN:NaN"
    // or "NaN:NaN:NaN:NaN" — the very corruption the clip-level guards above exist to prevent, one
    // line away. finiteNum returns null on failure, which IS the "absent" sentinel for in/out.
    inPoint: finiteNum(t.inPoint),
    outPoint: finiteNum(t.outPoint),
    fps: finiteNum(t.fps) ?? base.fps,
    loop: t.loop ?? false,
    automation: normalizeAutomation(t.automation),
    // BACK-COMPAT (Wave A) — see Timeline.boundedDuration for the whole story. `duration` used to be a
    // hint that never bounded playback, so old projects legitimately hold clips past it. Now that it IS
    // the end, obeying it blindly would silently truncate those shows. Raise it to cover the content —
    // but ONLY on a document that predates the bounded clock (no marker). A document that carries the
    // marker was authored against the bounded clock, so its Length is INTENTIONAL, including a Length
    // deliberately set short of the content end, and must survive the round-trip untouched. Without
    // that gate the raise re-ran on every load and silently, permanently destroyed the authored value.
    // Never lower it either — a deliberately long Length (trailing silence, a hold) is equally valid.
    // Guarded: duration/clip fields/outPoint can each independently be junk (NaN, a string, Infinity)
    // on a hand-edited or malformed project — finiteNum keeps one bad value from poisoning the max().
    // `=== true` (not truthy): `...rest` above can carry a hand-edited junk value for the marker, and
    // "junk" must read as ABSENT (do the migration) rather than as "already migrated".
    //
    // ONLY VIDEO `clips` extend the Length. trackingTakes, automation and Timeline.audio do NOT — an
    // audio clip past the end is authored content the user can see and one-click-fix on the ruler (the
    // overrun badge in Timeline.tsx), not a reason to silently rewrite their authored Length. Adding
    // audio to this max() would re-break the "deliberately short Length" invariant boundedDuration
    // exists to protect, on a container that did not even exist when a pre-Wave-A file was written.
    duration: t.boundedDuration === true
      ? finiteNum(t.duration) ?? base.duration
      : Math.max(
          finiteNum(t.duration) ?? base.duration,
          // `c?.` is defense in depth: `clips` is already filtered to objects above, but a bad
          // element shape (e.g. `start`/`duration` themselves missing or non-finite) must still
          // resolve to 0 rather than throw or poison the max() with NaN.
          ...clips.map(c => (finiteNum(c?.start) ?? 0) + (finiteNum(c?.duration) ?? 0)),
          finiteNum(t.outPoint) ?? 0,
        ),
    // Stamp the marker LAST (after `...rest`, so it also overrides a junk persisted value): the raise
    // above has now either happened or been correctly skipped, so from here on this document's Length
    // is authoritative — through buildProjectData, into the .artlux file, and back.
    boundedDuration: true,
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
// A timeline's own audio container (Timeline.audio — see there for the clock doctrine). Tracks + clips,
// deliberately NO buses: AudioBus is project-global (ProjectData.audio.buses) because there is exactly
// ONE output chain, and an output chain cannot be per-scene. Same clip/track shapes as the bed, so the
// same sanitizers, the same asset-path visitor and (Task 6) the same driver code serve both.
export interface TimelineAudio {
  tracks: AudioTrack[];
  clips: AudioClip[];
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
//
// ⚠ Until Wave B this was a SHAPE guard only: a NaN / "5" / Infinity start, a null slot inside `clips`,
// an array-typed clip, a track with `"gain": "x"` — all passed through untouched and reached the driver
// and the panel unguarded, while normalizeTimeline had guarded every one of those classes for VIDEO
// clips since Wave A. It now runs the SAME coercion Timeline.audio gets (normalizeTimelineAudio), so
// the bed finally has the sanitizer it never had. Behaviour change, deliberate: a bed clip's junk
// numbers are coerced on load and on every host.audio.setMix(). A sane bed round-trips unchanged.
export const normalizeAudioMix = (a: Partial<AudioMix> | null | undefined): AudioMix => {
  if (!a || typeof a !== 'object') return defaultAudioMix();
  const inner = normalizeTimelineAudio(a); // tracks + clips, coerced — the SAME guard Timeline.audio gets
  return {
    tracks: inner.tracks,
    clips: inner.clips,
    // Buses stay a shape guard (no numeric coercion here yet): a bus's `gain` is read through
    // masterBus()/`?? 1` and its effect params are a Record the plugin owns. Junk THERE is a separate
    // hole from the one this task closes; it is not widened by anything in Wave B.
    buses: (Array.isArray(a.buses) ? a.buses : [])
      .filter((b): b is AudioBus => !!b && typeof b === 'object' && !Array.isArray(b)),
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
  // AUDIO PARAMS THIS SCENE RECALLS — an explicit list, NOT a snapshot of the mix.
  //
  // A Scene is a LOOK snapshot for surfaces/fixtures/brightness, but audio deliberately is not: the mix is
  // a live, continuous thing (the bed does not restart on a recall — that is the whole point of the show
  // clock), and snapshotting it whole would force every leaf to be classified snap-vs-fade, including the
  // discrete `opts` strings the fade engine must never be handed. So a scene carries exactly the params the
  // operator CHOSE to bind, in the same {path, value} shape a Cue uses — recalled through the same fade
  // legs, with the same "a lane always wins" rule.
  //
  // ⚠ buildSceneSnapshot (App) is LOOK-ONLY and must stay that way: "Update Scene" spreads it over the
  // scene, so putting `audio` in it would silently re-capture the LIVE mix over a carefully bound list.
  // The cue panel's ♪ picker is the only writer.
  //
  // Absent ⇒ this scene changes no audio at all (which is what every existing project means).
  audio?: CueEntry[];
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

// A scene's bound audio entries — TOTAL OVER GARBAGE, on purpose, DOWN TO THE ENTRY.
//
// `Scene.audio` is the one Scene field with no normalizer in front of it: applyProjectData loads scenes
// with a spread (`{ ...s, accent, timeline }`), so whatever a hand-edited .artlux carries here reaches the
// recall path verbatim. And a `for…of` over a non-iterable ({} , 7, "x") THROWS — inside handleRecallScene,
// i.e. inside a GO, with no ErrorBoundary above it: a black show from a stray brace. Coerce, do not drop.
//
// ⚠ THE ARRAY GUARD IS NOT ENOUGH — A BAD *ELEMENT* IS THE SAME BLACK SHOW. Every consumer's first act is to
// dereference `e.path`: applyAudioEntries' `isFadeablePath(e.path)` (→ `path.split`) inside a GO, and the ♪
// inspector's `labelForPath(e.path)` / `isFadeablePath(e.path)` inside a RENDER. So `[null]`, `[{value:1}]`
// and `[{path:7}]` each throw — one on the next GO, one the moment the operator opens the list. React 19
// unmounts the tree on a throw in render and there is no ErrorBoundary above either: white screen, black
// projector, silent bed. Filter the ELEMENTS, not just the container: an entry needs an object shape and a
// string `path` to be addressable at all. (`value` is left to the consumer — applyAudioEntries wants a
// number, the inspector will happily display and re-type anything.)
//
// ⚠ AND `Cue.entries` IS THE SAME FIELD WITH THE SAME HOLE. It has no normalizer either (applyProjectData
// loads cue banks with a spread), and its consumers dereference `e.path` exactly as harshly: applyCues'
// `isPluginHeadEntry` (→ `path.split`) inside a GO, and the cue inspector's `labelForPath(e.path)` inside a
// RENDER. So the guard is not a Scene.audio guard — it is a CueEntry guard, and every reader of an unvetted
// entry list goes through `cueEntries()`, container and elements at once.
//
// An entry that fails this is not an authored value being coerced (invariant 6) — it is not ADDRESSABLE at
// all: no path, so nothing downstream could ever fire it, fade it, label it or delete it. It is dropped, not
// repaired, and the drop only persists if the operator edits that list — the same bargain Scene.audio makes.
export const isAddressableEntry = (e: unknown): e is CueEntry =>
  !!e && typeof e === 'object' && typeof (e as CueEntry).path === 'string';
export const cueEntries = (list: unknown): CueEntry[] =>
  Array.isArray(list) ? (list as unknown[]).filter(isAddressableEntry) : [];
export const sceneAudioEntries = (s: Scene | null | undefined): CueEntry[] => cueEntries(s?.audio);

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