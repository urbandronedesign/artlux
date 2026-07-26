import type {
  Scene3D, ProjectorOutput, SrcRect,
  // Imported (not just re-exported) because types declared HERE reference it — a lighting take is
  // keyed by role, and `export type { … } from` alone does not bring a name into local scope.
  ChannelRole,
} from '../../shared/protocol';

// DMX fixture profiles live in shared/protocol.ts, not here, because THREE consumers need them: the
// renderer (patching, the packer, the 3D scene), MAIN (it reads the bundled library off disk and
// serves it over IPC) and the project file itself (ProjectData.fixtureProfiles embeds the profiles a
// show actually uses, so a .artlux carried to a venue PC patches correctly even if that machine's
// library lacks them). Re-exported here so `from '../types'` keeps working everywhere in the
// renderer — the same arrangement Scene3D and ProjectorOutput already use.
export type {
  ChannelRole, ProfileRange, ProfileChannel, ProfileGeometry, ProfileGeoNode,
  ProfileMode, FixtureProfile, FixtureProfileSummary,
} from '../../shared/protocol';

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
  /**
   * Set by autoPatch when this fixture landed past what its controller can physically emit — a USB
   * DMX widget drives one universe, so the fifth 100-channel fixture on one has nowhere to go. It is
   * a REPORT, not a setting: the UI badges it so the overflow is a visible question rather than a
   * fixture that quietly never lights.
   */
  patchOverflow?: boolean;
  // ── DMX fixture profile (a moving head / wash / beam rather than a pixel strip) ──────────────
  // All three optional, so EVERY existing project loads unchanged and no migration is needed.
  //
  // `profileId` set ⇒ this is a PROFILED fixture, and three things change:
  //   · its DMX footprint is the MODE's, not ledCount × channelsPerPixel (see fixtureFootprint);
  //   · it is driven by named channel VALUES (`dmx`), not by sampling its surface's pixels;
  //   · `ledCount` is pinned to 1 — a moving head is one emitter, and letting it stay 16 would
  //     make the 3D scene draw sixteen LED spheres inside one housing.
  // Absent ⇒ every existing code path behaves exactly as before.
  profileId?: string;      // FixtureProfile.id; resolved project-embedded → user → bundled
  profileMode?: string;    // ProfileMode.key; absent ⇒ the profile's first mode
  // AUTHORED channel values, keyed by ProfileChannel.key, normalised 0..1 (pan/tilt are a fraction
  // of the channel's degree range, NOT degrees — the degrees live on the profile so one fixture's
  // stored show survives being repatched to a different head).
  //
  // This is the bottom of the precedence stack: profile defaults < THIS < lighting clip <
  // automation lane < live override. A key absent here falls back to the channel's `default`.
  dmx?: Record<string, number>;
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

// 'enttec' is a USB-serial DMX interface (ENTTEC DMX USB Pro and compatibles) rather than a network
// protocol. It carries a COM PORT instead of an IP, and one widget drives exactly ONE universe —
// both of which the patch has to respect. See docs/OUTPUTS.md → USB DMX.
export type OutputProtocol = 'artnet' | 'sacn' | 'enttec';

// S5 — a physical output device. Fixtures are assigned to one (controllerId) and
// auto-patched into its universes; Stage resolves each fixture's destination here.
export interface Controller {
  id: string;
  name: string;
  protocol: OutputProtocol;
  ip: string;
  /**
   * USB-serial port path for an 'enttec' controller — `COM3`, `/dev/ttyUSB0`. Chosen from the
   * discovered-device list in Outputs, never typed. Ignored by the network protocols.
   */
  port?: string;
  broadcast: boolean;
  priority?: number;     // sACN priority
  startUniverse?: number; // first universe this controller fills (default 0)
}

export interface OutputTarget {
  ip?: string;             // override controller IP (else global AppSettings.artNetIp)
  port?: string;           // 'enttec': override the controller's serial port path
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
  SLICE = 'SLICE',       // a cropped region of ANOTHER surface — how one picture spans several projectors
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
  // SLICE content — a cropped region of another Surface's picture. This is how ONE source spans
  // SEVERAL projectors: the source decodes once, and each slice is an ordinary Surface, so it gets
  // its own ProjectorOutput with its own corner-pin/Bézier homography, soft edge, gamma and colour
  // match. Neighbouring slices overlap; each feathers the shared edge. See services/outputSpan.ts
  // for the grid math and docs/OUTPUTS.md → Spanning.
  //
  // Resolved in services/surfaceMedia.getDrawable — the one seam the Stage composite, the WebGPU
  // per-surface LED sampler, the projector frame pump and the projector window ALL pass through,
  // which is why nothing downstream needed to learn about slicing.
  sliceOf?: string;    // source Surface id (must not be this surface, and must not itself be a SLICE)
  sliceRect?: SrcRect; // crop of the source's picture; absent ⇒ the whole thing (FULL_RECT)
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
// A layer is either a normal video track or one of the two TAKE lanes: 'tracking' holds recorded
// LiDAR blob takes (replayed into the tracking store), 'lighting' holds recorded or generated
// fixture movement (replayed into the lighting overlay). Absent kind ⇒ 'video'.
export type LayerKind = 'video' | 'tracking' | 'lighting';
export type LayerBlendMode = 'normal' | 'add' | 'screen' | 'multiply';
export interface VideoLayer {
  id: string;
  name: string;
  kind?: LayerKind;      // 'tracking'/'lighting' = take lanes; undefined/'video' = normal track
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
  // The layer's SOUND — deliberately NOT the `muted` field three lines up. That one means "excluded from
  // the program composite", i.e. a picture flag; conflating them would make hiding a layer silence it,
  // which no NLE does. This is the audio strip of the same track: mute/solo/gain over every clip on it.
  audio?: VideoLayerAudio;
}
export interface VideoLayerAudio {
  gain?: number;         // linear, default 1
  mute?: boolean;
  solo?: boolean;        // scoped to the video-audio container only — see the driver's audibleIn()
}
/**
 * A video clip's OWN soundtrack — the audio track inside the `.mp4`/`.mov` the clip already points at.
 *
 * ⚠ ABSENT MEANS AUDIBLE. `enabled` is undefined in every project authored before this existed, and it
 * reads as TRUE there exactly as it does in a new one: a decided behaviour change, not an oversight, and
 * normalizeTimeline stamps nothing to soften it (plans/video-clip-audio.md §Breaking changes). Existing
 * shows will make sound they never made before; the venue's recourse is the machine-level `Video clip
 * audio` switch, the operator's is this flag or the layer's mute.
 *
 * There is no `path` here and there never will be: the sound IS the clip's own file, so a link cannot go
 * stale and a trim cannot desynchronise it. The audio placement is DERIVED from the video clip every frame
 * (timelineEngine.getBoundVideoAudio), which is what makes blade/slip/move/undo free.
 */
export interface VideoClipAudio {
  enabled?: boolean;     // absent ⇒ TRUE. false = deliberately silent.
  gain?: number;         // linear, default 1
  mute?: boolean;
  offsetMs?: number;     // A/V trim, + = audio later. Folded into the derived clip's inPoint.
  fadeIn?: number;       // s
  fadeOut?: number;      // s
  spatial?: AudioSpatial;  // absent ⇒ non-spatial (the engine gives this away free — see docs/AUDIO.md)
  effects?: AudioEffect[]; // insert chain on the source, applied BEFORE spatialisation
}
// A clip placed on a track. All times are seconds.
export interface VideoClip {
  id: string;
  layerId: string;
  name: string;
  path: string;          // MP4 file path (video) or .lblob take file (tracking) — loaded via IPC
  kind?: 'video' | 'tracking' | 'lighting'; // matches the host layer's kind; undefined ⇒ 'video'
  takeId?: string;       // tracking clips: id of the source take in timeline.trackingTakes
  lighting?: LightingClip; // lighting clips: which take/effect, onto which group, with what spread
  // Generalized content: any surface source type (Image/Camera/DMX-in/Spout/NDI/Effect/Tracking)
  // scheduled on the layer for this clip's span. Absent (or type VIDEO) ⇒ legacy path-based video.
  content?: SurfaceContent;
  start: number;         // timeline position where the clip begins
  duration: number;      // clip length on the timeline
  inPoint: number;       // offset into the source where playback starts (trim)
  sourceDuration?: number; // full length of the source video/take (for trim limits)
  color?: string;        // per-clip tint override (optional)
  audio?: VideoClipAudio;  // the clip's own soundtrack — see VideoClipAudio; absent ⇒ audible
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
  | 'onTimelineEnd'      // when the bound timeline reaches its end (not looping) — auto-advance
  // THE WORLD OUTSIDE THE TIMELINE. A trigger whose condition a PLUGIN owns and evaluates: a person
  // entering a LiDAR trigger zone, a pose appearing on a camera, a DMX channel crossing a level.
  //
  // ONE core kind for all of them, on purpose. The persisted SHAPE is core — `kind`, `source`,
  // `params` — so a project file opens on any build and an unknown source is INERT rather than
  // corrupting (see triggerFires' exhaustiveness note). The BEHAVIOUR is not: it lives in whichever
  // plugin registered `source`, which is what "core stays core" means here. Adding the next trigger
  // source (mediapipe, augmenta, an audio level, an OSC value) needs no change to this file at all.
  | 'plugin';
export interface SmTrigger {
  kind: SmTriggerKind;
  seconds?: number;      // afterDelay
  time?: number;         // atTime
  markerId?: string;     // onMarker
  layerId?: string;      // onClipEnd
  // 'plugin' — which registered trigger source evaluates this, and its own opaque parameters. Core
  // never parses `params`; it hands the object back to the source that authored it (same contract as
  // an AutomationLane's targetPath tail, which only its provider understands).
  source?: string;                     // e.g. 'lidar.zone'
  params?: Record<string, unknown>;
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
  // GUARD: this transition may only fire once the SOURCE state's timeline has FINISHED — i.e. while
  // the scene clock is HELD on its last frame (Timeline.holdAtEnd; see the engine's hold branch). It
  // gates the TRIGGER, it is not one: the trigger still has to fire, this only says "not yet".
  //
  // Why it exists: the interactive shape this whole feature serves is "play the state's picture to its
  // end, freeze there, THEN let a person advance it". Without the guard a visitor who walks into a
  // trigger zone three seconds into a twenty-second clip CUTS IT — the show becomes unwatchable in
  // exactly the venue it was built for. `manual`/OSC transitions are gated too, deliberately: an
  // operator's GO on a state authored to run out is the same mistake, just slower.
  requireEnd?: boolean;
  // A GLOBAL RULE — evaluated from EVERY state, not just `from`. ("Someone walks into the entrance →
  // start the welcome", whatever the show happens to be doing.)
  //
  // The machine otherwise has no wildcard edge: a transition always leaves one source state, so making
  // a look reachable from everywhere meant hand-drawing an edge from every state and re-drawing them
  // all whenever a state was added — which is how an installation silently stops responding in the one
  // state somebody forgot.
  //
  // `from` is then meaningless (the editor lists these separately instead of drawing them, because a
  // rule with no source node is not an edge). Two rules keep it from running away, both in tick():
  // the current state's OWN edges are tried first — explicit beats global — and a global whose target
  // IS the current state is skipped, or a held condition would re-enter that state every frame and
  // restart its scene timeline forever.
  fromAny?: boolean;
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
  // UNATTENDED SAFETY NET — "if a state reaches its end and then nothing happens for this long, go
  // home." Seconds the CURRENT state may sit HELD (its picture finished, transport running on — see
  // Timeline.holdAtEnd / SmContext.held) with no transition firing before the machine force-returns to
  // `initialStateId`. Measured from when the hold BEGAN, not from state entry, so a 20 s clip that
  // holds for 5 min resets 5 min after it froze — exactly the "nobody walked in" case. `0`/absent =
  // off. The idle state itself is skipped (it is the target), so a held attract loop never resets to
  // itself. It is deliberately a LEVEL on `held`, not a per-transition trigger: it must cover EVERY
  // interactive state without an author having to draw an edge from each one (the same reason `fromAny`
  // exists), and a state that never holds — a loop, no hold authored — is never a stuck show to rescue.
  idleResetSec?: number;
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
  // THE STATE ENDED, AND THE SHOW DID NOT. Reaching the end HOLDS the scene clock on the last frame
  // instead of pausing the transport. LOOP WINS — ignored while `loop` is true (a wrap is not an end).
  //
  // A scene owns its timeline, so this is per-STATE: "play this look to <out-point>, freeze there, and
  // wait for something to move the machine on" — the shape an interactive, tracker-driven installation
  // is written in. The distinction from the plain end-stop is the whole point: the end-stop emits a
  // `pause`, and `playing: false` freezes the SHOW clock too, so the global audio bed and the global
  // automation stop dead while the room waits for a person. A HOLD writes nothing to `playing`: only
  // this document's playhead parks, the bed plays on underneath, and the machine is told (SmContext.held)
  // so a transition can be gated on it (SmTransition.requireEnd).
  //
  // The end is still `timelineEnd()` — the out-point, or Length. There is no separate "stop marker":
  // the out-handle already IS the authored end of a state, and one clock bound is easier to reason
  // about than two. See the engine's non-looping end branch (services/timeline.ts).
  holdAtEnd?: boolean;
  trackingTakes?: TrackingTakeRef[]; // recorded LiDAR-blob take library (drag onto a tracking lane)
  // Recorded fixture-movement takes. Stored INLINE rather than as sidecar files (which is what
  // tracking takes do) because a keyframe-reduced curve is small — a few hundred points per role —
  // and inlining removes an entire class of problem: no sidecar to lose, no asset path to rewrite
  // when a project folder moves, no extra IPC. Revisit if takes ever get long enough to bloat the
  // project file; the format below is already reduced on capture.
  lightingTakes?: LightingTake[];
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
  loop: false, holdAtEnd: false, trackingTakes: [], automation: [], audio: { tracks: [], clips: [] },
  boundedDuration: true,
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
  audio: sanitizeClipAudio(c.audio),
});

/**
 * Coerce a video clip's audio block. Same rule as everywhere else — COERCE, DO NOT DROP (invariant 6) —
 * but one field here is not merely cosmetic if it arrives malformed:
 *
 * ⚠ `spatial` REACHES THE AMBISONIC ENCODER. Every spatial source is encoded into ONE SHARED B-format bus
 * (SpatialBus::getNextAudioBlock), so a NaN coordinate on a single clip poisons the whole bus — silence,
 * or full-scale noise, on the audio thread, in a venue. NaN passes native SetClipSpatial's IsNumber()
 * guard, because NaN *is* a number. The audio driver bounds this at the engine door too
 * (plugin.renderer.ts finiteVec3) and both are wanted: this one keeps the DOCUMENT clean, that one
 * protects the engine from a document that never passed through here (a live in-memory Timeline).
 * A malformed position reads as NO position, i.e. the clip is simply not spatial.
 */
const sanitizeClipAudio = (a: VideoClipAudio | undefined): VideoClipAudio | undefined => {
  if (!a || typeof a !== 'object') return undefined;
  const s = a.spatial;
  const spatial = s && typeof s === 'object'
    && finiteNum(s.x) !== undefined && finiteNum(s.y) !== undefined && finiteNum(s.z) !== undefined
    ? s : undefined;
  return {
    ...a,
    // `enabled` is a tri-state on purpose: absent ⇒ audible. Only an explicit `false` silences a clip, so
    // a junk value must fall back to ABSENT and not to `false` — coercing junk into silence would be the
    // one coercion in this file that destroys the operator's sound rather than a number.
    enabled: a.enabled === false ? false : undefined,
    gain: finiteNum(a.gain),
    offsetMs: finiteNum(a.offsetMs),
    fadeIn: finiteNum(a.fadeIn),
    fadeOut: finiteNum(a.fadeOut),
    mute: a.mute === true ? true : undefined,
    spatial,
    effects: Array.isArray(a.effects) ? a.effects : undefined,
  };
};

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
// AN INSERT CHAIN IS AN ARRAY OR IT IS NOTHING. `effects` was the one field on a clip that this sanitizer
// spread straight through (`...c`), so whatever the file held reached the readers verbatim — and the audio
// plugin's enumerate() iterated it with a bare `for..of`, from compileAutomation, on EVERY project load and
// EVERY GO, with no try/catch. `"effects": {"0": {…}}` is therefore a CRASH ON LOAD: the app is dead before
// the operator sees a pixel. That array→object corruption is not hypothetical — this repo has already
// shipped it once (see the `segments` repair in applyProjectData).
//
// And not-throwing is not the same as being fine: a STRING is iterable, so `for (const fx of "reverb")`
// walks its CHARACTERS and silently emits six targets with an undefined id.
//
// Coerce, but do NOT eat the operator's work: an fx with an id and a type keeps its params untouched, and a
// null slot is filtered out of an otherwise-good chain rather than condemning the whole chain.
export const sanitizeEffects = (v: unknown): AudioEffect[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((fx): fx is AudioEffect =>
    !!fx && typeof fx === 'object'
    && typeof (fx as AudioEffect).id === 'string'
    && typeof (fx as AudioEffect).type === 'string');
  return out.length ? out : undefined;
};

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
  effects: sanitizeEffects(c.effects),
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
    // finiteNum's boolean twin, for the same reason as fps above: `??` only substitutes null/undefined,
    // so a hand-edited or tool-generated `"loop": "false"` (a non-empty string — TRUTHY) sailed through
    // and turned looping ON. Every consumer tests truthiness, not identity (services/timeline.ts:340,
    // 365, 401, 555, 636, 990), so the clock WRAPS at timelineEnd instead of parking: hitEnd never
    // pulses, onTimelineEnd never fires, and an FSM whose only outgoing transition is 'onTimelineEnd'
    // (services/stateMachine.ts:124) NEVER ADVANCES — the installation loops scene 1 all night with
    // `playing === true` and a green getStatus(). This is the one boolean in this object literal that
    // was left on bare `??` when boolOrAbsent landed (see AudioClip.mute / AudioTrack.mute+solo).
    // Round-trip is exact: an authored `true`/`false` passes through byte-for-byte; only junk (which
    // carries no recoverable authored intent) becomes ABSENT, which `?? false` reads as "off".
    loop: boolOrAbsent(t.loop) ?? false,
    // Same treatment as `loop`, and it fails in the same direction: a hand-edited `"holdAtEnd": "no"`
    // is a truthy string, and truthiness is what the engine's end branch tests. Junk must read as OFF
    // — turning a hold ON by accident freezes a show that was authored to run through, and reports
    // itself as playing while it does. An authored true/false round-trips byte-for-byte.
    holdAtEnd: boolOrAbsent(t.holdAtEnd) ?? false,
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
    // A bus's `gain` is still only a shape guard — it is read through masterBus()/`?? 1`, so junk there is
    // survivable. Its `effects` is NOT: the comment here used to call that "a separate hole… not widened by
    // anything in Wave B", and it was right about the provenance and wrong about the consequence. The audio
    // plugin's enumerate() iterates the MASTER bus's chain with a bare `for..of`, from compileAutomation, on
    // every project load and every GO — so `"effects": {"0": {…}}` on the master bus is a CRASH ON LOAD,
    // exactly as it is on a clip. Same coercion, same reason. (The readers are hardened too — a plugin can
    // write a bus the sanitizer never sees — but the door is where it belongs.)
    buses: (Array.isArray(a.buses) ? a.buses : [])
      .filter((b): b is AudioBus => !!b && typeof b === 'object' && !Array.isArray(b))
      .map((b): AudioBus => ({ ...b, effects: sanitizeEffects(b.effects) })),
  };
};

// Normalize a persisted/partial state machine into a complete one (fills new fields on old saves).
//
// TOTAL OVER GARBAGE — CONTAINER *AND* ELEMENT. This is the ONLY normalizer on the container (its single
// call site is applyProjectData), it runs on every load, and its consumers check nothing.
//
// ⚠ `??` ONLY SUBSTITUTES null/undefined. It does NOT catch `{"0":…}` — the array→object corruption class
// THIS CODEBASE HAS ALREADY WRITTEN ONCE (see the `segments` repair in applyProjectData: "a non-array
// `segments` (e.g. {"0":…} from a pre-fix cue write) is always garbage"). So `transitions ?? []` passed a
// junk container straight through to:
//   · StateLane.tsx:24-25 — `sm.transitions.filter(t => … t.trigger.kind …)`, in a lane that is rendered
//     UNCONDITIONALLY (Timeline.tsx, "always-present state-machine control lane"). `.filter is not a
//     function` IN RENDER, and there is no ErrorBoundary in this renderer — React 19 unmounts the tree:
//     WHITE SCREEN ON LOAD, black projector, silent room, with nothing opened and nobody in the venue.
//   · services/stateMachine.ts:156 — `for (const tr of sm.transitions)`. tick()'s re-init branch RETURNS
//     BEFORE that loop, so the initial recall SUCCEEDS and only subsequent frames throw — into the
//     try/catch at services/timeline.ts's fsm.tick call. Net: the machine enters state 1, recalls scene 1,
//     and then never evaluates a single transition for the rest of the night, while getStatus() reports a
//     live currentStateId and `playing: true`. A watchdog sees a perfectly healthy show. That is the
//     self-reporting-healthy failure class, which is worse than the crash.
//
// ⚠ AND A BAD *ELEMENT* IS THE SAME WHITE SCREEN. StateLane derefs `t.from` and `t.trigger.kind` on EVERY
// element in render; enter()/runEntry() do `for (const a of s.entry)`. So `[null]`, a transition with no
// `trigger`, and a state with `"entry": 7` each throw exactly like the container does. Guard both levels.
//
// COERCE, DO NOT DROP, wherever there is something to recover. A state/transition keeps every field it
// carries (spread first, like sanitizeClip); only what a consumer ITERATES or DEREFERENCES is repaired.
// A trigger-less transition KEEPS ITS EDGE and is coerced to 'manual' — the one kind that can never fire
// by itself (triggerFires returns false for it; only triggerManual() fires it), so a corrupt graph cannot
// recall a scene at 3am on its own, and the operator can still see and re-author the edge in the graph
// editor. An element that is not even an object holds nothing addressable and is dropped, exactly as
// normalizeTimeline drops a non-object clip. A SANE MACHINE ROUND-TRIPS BYTE-FOR-BYTE (invariant 6): every
// authored field is spread through untouched, so nothing here can persist a coercion over a real value.
export const normalizeStateMachine = (sm: Partial<StateMachine> | null | undefined): StateMachine => {
  if (!sm || !Array.isArray(sm.states)) return defaultStateMachine();
  // The container guard `states` already has, for the two containers that never got one — plus the
  // element guard all three need. A non-array container yields []; a junk element is not addressable.
  const objectsIn = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? (v as unknown[]) : []).filter(
      (e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e),
    );
  return {
    enabled: !!sm.enabled,
    states: objectsIn(sm.states).map((s) => ({
      ...(s as unknown as SmState),
      // runEntry() does `for (const a of s.entry)` on state ENTRY — i.e. inside a recall, inside a GO.
      // A missing/junk `entry` (an old save, a hand-edit) is not iterable and throws there.
      entry: Array.isArray(s.entry) ? (s.entry as SmAction[]) : [],
    })),
    transitions: objectsIn(sm.transitions).map((t) => ({
      ...(t as unknown as SmTransition),
      // The guard is read as TRUTHINESS in tick(), so junk fails the WRONG way: `"requireEnd": "no"`
      // would hold the transition until the state's timeline ends — and on a state that loops, or has
      // no hold authored at all, that is never. The show sits on one look with a green status. Coerce
      // to ABSENT (= ungated), the behaviour every project written before this field already has.
      requireEnd: boolOrAbsent(t.requireEnd),
      // Junk here is far worse than junk in `requireEnd`: a truthy string would promote an ordinary
      // edge into a rule that fires from EVERY state in the show. Coerce to absent (= a normal edge).
      fromAny: boolOrAbsent(t.fromAny),
      trigger:
        !!t.trigger && typeof t.trigger === 'object' && !Array.isArray(t.trigger)
          ? (t.trigger as SmTrigger)
          : { kind: 'manual' as const }, // inert by construction — see above
    })),
    // A non-string id can never match a state id anyway (tick falls back to states[0]); make the type
    // honest so no consumer is handed a number where it was promised `string | null`.
    initialStateId: typeof sm.initialStateId === 'string' ? sm.initialStateId : null,
    regions: objectsIn(sm.regions) as unknown as SmRegion[],
    // A junk/negative value must read as OFF, not as "reset every frame": finiteNum drops non-numbers,
    // and we require > 0 so a hand-edited `0` / `-1` disables it (the behaviour of every prior save).
    idleResetSec: (() => { const n = finiteNum(sm.idleResetSec); return n != null && n > 0 ? n : undefined; })(),
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

// ── THE MACHINE, NOT THE SHOW ───────────────────────────────────────────────────────────────────────
// AppSettings describes THIS COMPUTER and THIS BUILDING: the sound card, the Art-Net target, the OSC
// listener, the output gamma. It is persisted in `Prefs.appSettings` (per-machine) and is **NEVER written
// to a project file** — opening a show must not repatch the venue. (It used to be written to both, and the
// file's copy won: a project authored in binaural/2ch flipped an octagon rig to a headphone mix.)
//
// Adding a field here? Ask whose data it is. If the answer is "the show's", it belongs in ProjectData —
// as `reserveLockedRanges` now does.
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
  // Cold start: how long the show waits for its opening content to decode before the state machine is
  // armed anyway (services/bootGate). The gate ALWAYS fails open — this is how much patience a venue
  // has for a missing/slow asset, not whether it waits forever. Absent ⇒ 15s. MACHINE-scoped like
  // everything else here: the same show on a slower disk deserves a longer wait, and that is a
  // property of the building, not of the project.
  bootPreloadSec?: number;
  // Namespace for plugin-private settings that don't warrant a core field. A plugin keys by its id
  // (`settings.plugins?.['my-plugin']`) and owns the shape. Cross-app persisted settings that the host
  // also reads (like mp4WebCodecs) stay top-level core fields; this is for genuinely plugin-local prefs.
  //
  // ⚠ MACHINE-SCOPED, like everything else in AppSettings: this namespace is NOT persisted to a project
  // file. Its three consumers today are all hardware/network prefs — `audio` (the output device),
  // `show-control` (the LAN port + PIN), `mediapipe` (the camera). A plugin needing PER-PROJECT data puts
  // it in ProjectData, not here; anything left here does not travel with the show.
  plugins?: Record<string, unknown>;
}

// ── PATCH POLICY — the ONE show-scoped field that used to live in AppSettings ────────────────────────
// AppSettings is THE MACHINE (see its own header) and is no longer written to a project file. This flag
// is not the machine: it governs how THIS PROJECT'S auto fixtures are addressed around its locked ranges,
// so it must travel WITH the show or the same rig patches differently on a different laptop.
//
// ⚠ `reserveLockedRanges` is REQUIRED here, and that is load-bearing. autoPatch() used to take
// `settings?: AppSettings`. An all-OPTIONAL policy type would structurally accept an AppSettings that no
// longer has the field — every call site would still compile, the flag would read `undefined` forever,
// and tsc would stay green. `strict` is off in this repo; a green tsc is weaker evidence than it looks.
// Required ⇒ the compiler names every call site.
export interface PatchPolicy {
  reserveLockedRanges: boolean;
}

// The new field wins; LEGACY projects carried the flag inside `data.settings`, which is no longer read
// (see App.tsx applyProjectData). Absent ⇒ false, the documented default.
export function readPatchPolicy(data: any): PatchPolicy {
  const legacy = data?.settings?.reserveLockedRanges;
  return {
    reserveLockedRanges:
      typeof data?.reserveLockedRanges === 'boolean' ? data.reserveLockedRanges
      : typeof legacy === 'boolean' ? legacy
      : false,
  };
}

// `ViewMode` and `Module` (the MadMapper-style MEDIA/MAP/FIXTURES/THREE_D switcher) lived here and
// were REMOVED — both had been dead since the Workspace-v2 refactor dropped the ModuleSwitcher, and
// the top-level-mode idea they encoded is now the workspace CONTEXT (`WorkspaceContext` in
// @artlux/sdk/renderer + `contextRegistry`), which drives the panels themselves and not just the
// centre stage. See docs/WORKSPACE.md.

// How the Media library draws its assets — Explorer's "large icons / medium icons / list". A view
// preference, so it lives in the workspace layout (prefs) next to `leftTab`, not in the project.
export type MediaView = 'large' | 'medium' | 'list';

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

// ── ENCODING A LIGHT SHOW ────────────────────────────────────────────────────────────────────
//
// A console encodes movement as an EFFECT with a phase spread across an ordered selection, not as
// one curve per fixture per parameter — because forty heads × twenty channels is not something a
// person can draw. ArtLux already has the half nobody else has (a real NLE timeline with clips), so
// a light show here is: a fixture-agnostic TAKE, instanced onto an ordered GROUP by a timeline CLIP
// that spreads it in time.
//
// THE TAKE IS IN ROLE SPACE, NOT FIXTURE SPACE. Values are keyed by what a channel MEANS (pan, tilt,
// dimmer) and pan/tilt are stored in DEGREES. That is the whole reason a take can be assigned to a
// group at all, and it is also why swapping the rig does not destroy the show: a movement recorded
// on a 540° head replays as the same ANGLE on a 630° head. Consoles call that head morphing.

/** One sampled curve: times in seconds (ascending), values in the role's own unit. */
export interface LightingCurve {
  t: number[];
  v: number[];
}

/**
 * One "part" of a take — the movement of a single position in the spread.
 *
 * A take with ONE part is a single movement fanned across however many fixtures the clip targets.
 * A take with EIGHT is a recorded eight-fixture chase, kept intact. Part i drives fixture i of the
 * target group, wrapping if the group is longer.
 */
export interface LightingTakePart {
  channels: Partial<Record<ChannelRole, LightingCurve>>;
}

export interface LightingTake {
  version: 1;
  id: string;
  name: string;
  duration: number;           // seconds
  fps?: number;               // nominal capture rate, informational
  parts: LightingTakePart[];  // ordered
}

/** The shape of a generated (procedural) movement — a console "phaser", with no recording behind it. */
export type LightingForm = 'sine' | 'triangle' | 'ramp' | 'square' | 'random';

export interface LightingEffect {
  form: LightingForm;
  role: ChannelRole;      // which parameter it drives
  centre: number;         // role units (degrees for pan/tilt, 0..1 otherwise)
  amplitude: number;      // ± this much around the centre
  periodSec: number;      // one full cycle
}

/** How a clip spreads its take across the fixtures of its group. */
export type LightingPhaseMode = 'spread' | 'wing' | 'block' | 'random';

export interface LightingClip {
  /** The recorded take. Mutually exclusive with `effect`. */
  takeId?: string;
  /** A generated movement instead of a recording. Mutually exclusive with `takeId`. */
  effect?: LightingEffect;
  /**
   * The ORDERED group this clip drives. Order is the spread axis, exactly as a console's selection
   * order is — which is why groups are never sorted on the way in.
   */
  groupId?: string;
  /** Seconds of delay per step along the group. 0 ⇒ every fixture moves together. */
  phase?: number;
  phaseMode?: LightingPhaseMode;
  wings?: number;          // 'wing': mirror the spread outward from the centre in N wings
  blocks?: number;         // 'block': fixtures move in N blocks rather than individually
  /** Negate pan about its centre for the second half — the other half of a symmetric look. */
  mirror?: boolean;
  scale?: number;          // amplitude multiplier about the take's own centre (default 1)
  offset?: number;         // added to every value, in role units
  /** Only these roles are driven; absent ⇒ every role the take carries. */
  roleMask?: ChannelRole[];
}

// A named snapshot of the look (instant recall). Captures the visible state — surfaces, fixtures,
// brightness, groups, 3D scene and projector outputs — and it ALWAYS OWNS ITS OWN `timeline` (a
// per-scene decoupled NLE): recalling the scene warm-swaps the playback engine to it.
//
// ⚠ THIS COMMENT USED TO SAY THE OPPOSITE, and it contradicted the field's own comment thirteen lines
// below for four days. It said the scene "MAY now own its own timeline … when absent the scene falls back
// to the shared ProjectData.timeline", and that fallback SHAPE WAS DELETED on 2026-07-14 (see `timeline`
// below — it was the root of two automation-clock blockers). A stale header on a persisted type is worse
// than a stale doc: it is what the docs get written FROM, and docs/SCENES.md and docs/SCENE-TIMELINES.md
// both copied it faithfully.
//
// Recall snaps instantly in v1; `fadeSec` is stored for a future crossfade engine. Every field beyond
// fixtures/globalBrightness/timeline is optional so older minimal scenes still load — and a scene loaded
// WITHOUT a timeline (a pre-2026-07-14 file) is given an empty one by the loader, never a fallback.
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
  // EVERY SCENE OWNS A TIMELINE. This was `timeline?: Timeline` — "absent → uses the shared global
  // timeline" — and that shape was deleted on 2026-07-14. It caused two merge blockers and it was not a
  // feature: NOTHING in the UI could create one (handleCreateState calls defaultTimeline(), handleCaptureScene
  // clones), so it existed only in a hand-written file, while the scene pill carried a read-only "plays
  // global" label for a state the operator could not produce. Nor was it what it looked like: an absent
  // timeline did not mean "leave the transport alone", it meant "bind the global doc and RESTART its playhead
  // at 0". Nobody designed that; it fell out of the data model.
  //
  // The blockers: a timeline-less scene MATERIALISED a copy of the global doc on its first ordinary edit
  // (even pressing Loop), and that copy carried the global doc's `automation` array — which compileAutomation
  // then retagged from the SHOW clock to the SCENE clock, while ALSO shadowing the real base lane by
  // targetPath (timeline.ts:519). A house fade on audio.master.gain jumped +9.6 dB in one frame, and the
  // materialised timeline was persisted, so it recurred on every GO thereafter.
  //
  // Required, so neither can happen: there is no timeline-less scene to materialise from.
  // If a scene that does not touch the transport is ever wanted, design it explicitly
  // (Scene.transport: 'restart' | 'preserve') with a real, named control the operator can see.
  timeline: Timeline;
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

// The CueBank CONTAINER's normalizer — the one document container that had none. applyProjectData used to
// do `if (Array.isArray(data.cueBanks) && data.cueBanks.length) setCueBanks(data.cueBanks as CueBank[])`:
// THE CAST WAS THE VALIDATION. `Array.isArray` guards the OUTER array only; the bank objects, `bank.cues`
// and `bank.sceneCells` arrived raw, and every consumer dereferences them without a check.
//
// This is the level ABOVE cueEntries() — Wave B hardened the entry list precisely because "Cue.entries is
// document data with no normalizer in front of it", and left the list's OWNER unguarded. Same doctrine,
// one level up.
//
//   · IN RENDER (a throw here = React 19 unmounts the tree = WHITE SCREEN ON LOAD; there is no
//     ErrorBoundary in this renderer): App's OWN render does `cueBanks.flatMap(b => b.cues.map(...))` to
//     build the timeline's cue list — that is NOT gated on a dock tab, it runs on the ordinary boot path.
//     CueBankPanel then does `Math.max(bank.cols, ...bank.cues.map(c => c.col + 2), ...)` — its `if
//     (!bank)` bail catches a MISSING bank, never a bank whose `cues` is `{"0":…}`.
//   · ON A GO: fireColumn derefs `b.id` inside its `.find` predicate (a null element throws), then
//     `bank.sceneCells.find(...)` and `bank.cues.filter(...)`. cueBus fires it with a bare
//     `forEach(cb => cb(bankRef, col))` — no try/catch — so an OSC /artlux/column reaches it raw. React 19
//     does NOT unmount for a throw outside render, so this one does not white-screen: the column simply
//     NEVER FIRES, the show sits on the previous look, and everything reports green.
//
// COERCE, DO NOT DROP. A bank/cue/cell object keeps every field it carries (spread first), and only what a
// consumer ITERATES or feeds to ARITHMETIC is repaired: the three containers get an array guard, their
// elements an object guard, and the numbers that drive the grid (`rows`/`cols`/`row`/`col`) and the fade
// engine (`fadeSec` → `Math.max(0, sec) * 1000`, which is NaN for a junk value and writes NaN into every
// faded param) get finiteNum. `Cue.entries` is deliberately LEFT RAW: cueEntries() already guards it at
// every consumer, container and element, and dropping unaddressable entries HERE would persist that drop
// on the next save (invariant 6). A sane bank round-trips byte-for-byte.
export const normalizeCueBanks = (list: unknown): CueBank[] => {
  const objects = (v: unknown): Record<string, unknown>[] =>
    (Array.isArray(v) ? (v as unknown[]) : []).filter(
      (e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e),
    );
  const d = defaultCueBank('');
  return objects(list).map((b) => ({
    ...(b as unknown as CueBank),
    rows: finiteNum(b.rows) ?? d.rows,
    cols: finiteNum(b.cols) ?? d.cols,
    cues: objects(b.cues).map((c) => ({
      ...(c as unknown as Cue),
      row: finiteNum(c.row) ?? 1, // rows 1+ are cue rows; row 0 is reserved for scenes
      col: finiteNum(c.col) ?? 0,
      fadeSec: finiteNum(c.fadeSec) ?? 0, // a missing/junk fade is a SNAP, which is what the panel already shows
    })),
    sceneCells: objects(b.sceneCells).map((c) => ({
      ...(c as unknown as CueBank['sceneCells'][number]),
      col: finiteNum(c.col) ?? 0,
    })),
  }));
};

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