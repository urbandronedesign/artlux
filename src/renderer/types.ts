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

// A contiguous LED sub-range of a fixture with its own effect/palette. When a
// fixture has no segments, the whole fixture acts as one implicit segment.
export interface Segment {
  start: number;   // first LED index within the fixture (inclusive)
  stop: number;    // last LED index (exclusive)
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
  NONE = 'NONE'
}

// A Surface is a rectangular region on the stage carrying one content source.
// Fixtures sample surfaces (see Fixture.surfaceId). EFFECT content is rendered
// in S2; for now it shows nothing.
export interface SurfaceContent {
  type: SourceType | 'EFFECT';
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
  | 'onClipEnd';         // when the active clip on `layerId` ends (a gap appears)
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

export interface Timeline {
  layers: VideoLayer[];
  clips: VideoClip[];
  duration: number;      // length hint (zoom-to-fit / Length field) — NOT a playback wrap point
  fps?: number;          // frame rate for HH:MM:SS:FF timecode (default 30)
  markers?: Marker[];    // ruler markers
  inPoint?: number | null;  // timeline range start (export/loop region) — NOT clip trim
  outPoint?: number | null; // timeline range end
  loop?: boolean;        // when true, playback wraps over [inPoint, outPoint); else unbounded
  trackingTakes?: TrackingTakeRef[]; // recorded LiDAR-blob take library (drag onto a tracking lane)
  /** @deprecated moved to project scope (ProjectData.stateMachine); kept read-only for migration. */
  stateMachine?: StateMachine;
}
export const defaultTimeline = (): Timeline => ({
  layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
  loop: false, trackingTakes: [],
});

// Fill defaults for fields added after a project was saved, so old projects load cleanly.
// Top-level fields would migrate via the spread in App's loader, but per-array fields
// (layer/clip) need explicit defaulting — done here in one place.
export const normalizeTimeline = (t: Partial<Timeline> | null | undefined): Timeline => {
  const base = defaultTimeline();
  if (!t || !Array.isArray(t.layers)) return base;
  const { stateMachine: _legacySm, ...rest } = t; // legacy field migrated to project scope in App's loader
  return {
    ...base,
    ...rest,
    layers: (t.layers ?? []).map(l => ({ enabled: true, ...l })),
    clips: t.clips ?? [],
    trackingTakes: t.trackingTakes ?? [],
    markers: t.markers ?? [],
    inPoint: t.inPoint ?? null,
    outPoint: t.outPoint ?? null,
    fps: t.fps ?? base.fps,
    loop: t.loop ?? false,
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
}

// Phase I — named selection set for batch operations.
export interface FixtureGroup {
  id: string;
  name: string;
  fixtureIds: string[];
}

// A named snapshot of the look (instant recall). Captures the visible state — surfaces,
// fixtures, brightness, groups, 3D scene and projector outputs — but NOT the timeline/assets
// (the playing transport + media library) or rig wiring (controllers/settings). Recall snaps
// instantly in v1; `fadeSec` is stored for a future crossfade engine. Every field beyond
// fixtures/globalBrightness is optional so older minimal scenes still load.
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