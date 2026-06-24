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
  LAYER = 'LAYER',       // a timeline track (by layerId)
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
  // EFFECT params (S2):
  effectId?: number;
  paletteId?: number;
  speed?: number;
  intensity?: number;
}

// --- Video-layer timeline (NLE) ---
// A layer is a track = an addressable output channel; surfaces/3D planes bind to its id.
// The header flags (muted/solo/locked/enabled) are EDIT-UX only — the playback engine
// (services/timeline.ts) ignores them so playback/compositing is unchanged.
export interface VideoLayer {
  id: string;
  name: string;
  height?: number;       // lane height in px (default LANE_H)
  color?: string;        // hex label color for the track header (default none)
  muted?: boolean;       // UX-only dim flag (engine ignores)
  solo?: boolean;        // UX-only highlight flag (engine ignores)
  locked?: boolean;      // prevents clip edits on this track in the UI
  enabled?: boolean;     // visibility toggle (UX-only); default true
}
// A clip placed on a track. All times are seconds.
export interface VideoClip {
  id: string;
  layerId: string;
  name: string;
  path: string;          // MP4 file path (loaded per-window via IPC → Blob URL)
  start: number;         // timeline position where the clip begins
  duration: number;      // clip length on the timeline
  inPoint: number;       // offset into the source where playback starts (trim)
  sourceDuration?: number; // full length of the source video (for trim limits)
  color?: string;        // per-clip tint override (optional)
}
// A point of interest on the timeline ruler.
export interface Marker {
  id: string;
  time: number;          // seconds
  color: string;         // hex
  note?: string;
}

// --- State machine (control layer) ---
// An always-available, optional finite-state graph that can drive the transport (play/pause/
// seek/loop) as the playhead moves. It lives OUTSIDE layers[]/clips[] so the video engine is
// untouched. While `enabled`, the engine runtime (services/stateMachine.ts) evaluates the
// current state's outgoing transitions each frame and emits transport intents back to App.
export type SmActionKind = 'play' | 'pause' | 'stop' | 'seek' | 'setLoop' | 'jumpMarker';
export interface SmAction {
  kind: SmActionKind;
  seekTo?: number;       // seconds — for 'seek'
  loopOn?: boolean;      // for 'setLoop'
  markerId?: string;     // for 'jumpMarker'
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
}
export interface SmTransition {
  id: string;
  from: string;          // SmState.id
  to: string;            // SmState.id
  trigger: SmTrigger;
}
export interface StateMachine {
  enabled: boolean;
  states: SmState[];
  transitions: SmTransition[];
  initialStateId: string | null;
}
export const defaultStateMachine = (): StateMachine => ({
  enabled: false, states: [], transitions: [], initialStateId: null,
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
  stateMachine?: StateMachine; // optional control-layer FSM
}
export const defaultTimeline = (): Timeline => ({
  layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
  loop: false, stateMachine: defaultStateMachine(),
});

// Fill defaults for fields added after a project was saved, so old projects load cleanly.
// Top-level fields would migrate via the spread in App's loader, but per-array fields
// (layer/clip) need explicit defaulting — done here in one place.
export const normalizeTimeline = (t: Partial<Timeline> | null | undefined): Timeline => {
  const base = defaultTimeline();
  if (!t || !Array.isArray(t.layers)) return base;
  const sm = t.stateMachine;
  return {
    ...base,
    ...t,
    layers: (t.layers ?? []).map(l => ({ enabled: true, ...l })),
    clips: t.clips ?? [],
    markers: t.markers ?? [],
    inPoint: t.inPoint ?? null,
    outPoint: t.outPoint ?? null,
    fps: t.fps ?? base.fps,
    loop: t.loop ?? false,
    stateMachine: sm
      ? { enabled: !!sm.enabled, states: sm.states ?? [], transitions: sm.transitions ?? [], initialStateId: sm.initialStateId ?? null }
      : defaultStateMachine(),
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
}

// Phase I — named selection set for batch operations.
export interface FixtureGroup {
  id: string;
  name: string;
  fixtureIds: string[];
}

// Phase I — a named snapshot of the look (instant recall).
export interface Scene {
  id: string;
  name: string;
  fixtures: Fixture[];
  globalBrightness: number;
}

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