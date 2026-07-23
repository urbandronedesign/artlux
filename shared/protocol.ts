// Shared IPC contract between the Electron main process and the renderer.
// Imported by both sides so channel names and payload shapes stay in sync.

export const IPC = {
  /** Renderer → main: set/refresh the UDP output target. */
  CONFIGURE: 'dmx:configure',
  /** Renderer → main: ship one frame of universe data to transmit. */
  FRAME: 'dmx:frame',
  /** Main → renderer: output connection/health status. */
  STATUS: 'dmx:status',
  /** Main → renderer: native engine throughput stats (~1 Hz). */
  STATS: 'dmx:stats',
  /** Renderer → main: renderer frame-time stats (~1 Hz) → Prometheus (broadcast has no HUD). */
  RENDER_STATS: 'render:stats',
  /** Renderer → main: start/stop Art-Net/sACN input capture. */
  INPUT_CONFIGURE: 'input:configure',
  /** Main → renderer: latest received input universes. */
  INPUT_FRAME: 'input:frame',
  /** Renderer → main (invoke): write a project; opens a Save dialog when no path. */
  PROJECT_SAVE: 'project:save',
  /** Renderer → main (invoke): Open dialog → { path, data }. */
  PROJECT_OPEN: 'project:open',
  /** Renderer → main (invoke): read a project from a known path (recents/headless). */
  PROJECT_LOAD_PATH: 'project:load-path',
  /** Renderer → main (invoke): export a rig (patch/wiring/routing only). */
  RIG_EXPORT: 'rig:export',
  /** Renderer → main (invoke): import a rig file. */
  RIG_IMPORT: 'rig:import',
  /** Renderer → main (invoke): read persisted preferences. */
  PREFS_GET: 'prefs:get',
  /** Renderer → main (invoke): merge + persist preferences. */
  PREFS_SET: 'prefs:set',
  /** Renderer → main (invoke): clamp + persist + apply the main-window UI scale (zoom factor). */
  UI_SCALE_SET: 'ui-scale:set',
  /** Renderer → main (invoke): compute a first-run default UI scale from the primary display. */
  UI_SCALE_DETECT: 'ui-scale:detect',
  /** Renderer → main (invoke): ArtPoll broadcast → discovered Art-Net nodes. */
  ARTNET_DISCOVER: 'artnet:discover',
  // Spout + NDI channels moved to their plugins (carried over the generic 'plugin:spout:*' /
  // 'plugin:ndi:*' bridge).
  /** Renderer → main: enable/disable the OSC UDP listener (external control + LiDAR tracking). */
  OSC_CONFIGURE: 'osc:configure',
  /** Main → renderer: a batch of received OSC messages (one UDP packet → 1+ messages). */
  OSC_MESSAGE: 'osc:message',
  /** Renderer → main: send one OSC message to a target host:port (send scaffold). */
  OSC_SEND: 'osc:send',
  /** Renderer → main (invoke): list this machine's local IPv4 addresses (for NIC binding). */
  OSC_LOCAL_ADDRS: 'osc:local-addrs',
  // HAP video + CALIB_* channels moved to their plugins (carried over the generic 'plugin:hap:*' /
  // 'plugin:calib:*' bridge).
  /** Renderer → main (invoke): is the NVAPI scanout warp/blend addon available (Quadro/RTX-pro)? */
  NVWARP_AVAILABLE: 'nvwarp:available',
  /** Renderer → main (invoke): push a scanout warp mesh (XYUVRQ) to an Electron display. */
  NVWARP_SET_WARP: 'nvwarp:set-warp',
  /** Renderer → main (invoke): push a scanout intensity/blend map (RGB) to an Electron display. */
  NVWARP_SET_INTENSITY: 'nvwarp:set-intensity',
  /** Renderer → main: clear scanout warp + intensity from an Electron display. */
  NVWARP_CLEAR: 'nvwarp:clear',
  /** Renderer → main (invoke): export projector warp+blend regions as an .mpcdi file (save dialog). */
  MPCDI_EXPORT: 'mpcdi:export',
  /** Renderer → main (invoke): import an .mpcdi file (open dialog) → regions. */
  MPCDI_IMPORT: 'mpcdi:import',
  /** Main → renderer: a native-menu command (save/open/undo/about/…). */
  MENU_ACTION: 'menu:action',
  /** Renderer → main (invoke): app name + version (for About). */
  APP_INFO: 'app:get-info',
  /** Renderer → main: open a URL in the default browser. */
  OPEN_EXTERNAL: 'app:open-external',
  /** Renderer → main: relaunch the app in broadcast mode with the given project path. */
  APP_RELAUNCH_BROADCAST: 'app:relaunch-broadcast',
  /** Renderer → main (invoke): current watchdog status + recent self-heal events. */
  WATCHDOG_STATUS: 'watchdog:status',
  /** Renderer → main (invoke): install the Tier-2 OS supervisor (Windows Scheduled Task). */
  WATCHDOG_INSTALL_TASK: 'watchdog:install-task',
  /** Renderer → main (invoke): remove the Tier-2 OS supervisor task. */
  WATCHDOG_UNINSTALL_TASK: 'watchdog:uninstall-task',
  /** Main → renderer: a watchdog detection/recovery event (live push for the audit UI). */
  WATCHDOG_EVENT: 'watchdog:event',
  /** Renderer → main: a window/role command from the custom title bar (minimize, close, reload, …). */
  WINDOW_COMMAND: 'window:command',
  /** Renderer → main (invoke): is the main window currently maximized? */
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  /** Main → renderer: the main window's maximized state changed (toggle the restore/maximize icon). */
  WINDOW_MAXIMIZE_CHANGED: 'window:maximize-changed',
  /** Renderer → main: check GitHub for a newer release. */
  UPDATE_CHECK: 'update:check',
  /** Renderer → main: user accepted — download the available update. */
  UPDATE_DOWNLOAD: 'update:download',
  /** Renderer → main: user accepted — quit and install the downloaded update. */
  UPDATE_INSTALL: 'update:install',
  /** Main → renderer: auto-update lifecycle events. */
  UPDATE_EVENT: 'update:event',
  /** Renderer → main (invoke): pick a GLB/glTF venue model → absolute path. */
  SCENE_PICK_MODEL: 'scene:pick-model',
  /** Renderer → main (invoke): read a model file's bytes by path. */
  SCENE_READ_MODEL: 'scene:read-model',
  /** Renderer → main (invoke): read any file's bytes by path (e.g. timeline MP4s). */
  READ_FILE: 'app:read-file',
  /** Renderer → main (invoke): list the in-app docs tree (example sets + tutorials + user guide). */
  DOCS_LIST: 'docs:list',
  /** Renderer → main (invoke): read one doc's markdown by tree id → { markdown, dir }. */
  DOCS_READ: 'docs:read',
  /** Renderer → main (invoke): read a sibling image referenced by a doc (validated) → { mime, data }. */
  DOCS_READ_ASSET: 'docs:read-asset',
  /** Renderer → main: open (or focus) the detached Docs window, optionally at a doc id. */
  DOCS_OPEN_WINDOW: 'docs:open-window',
  /** Renderer (docs window) → main: load an example project into the MAIN editor window. */
  DOCS_OPEN_EXAMPLE: 'docs:open-example',
  /** Renderer → main (invoke): write a recorded LiDAR-blob take to a sidecar file → absolute path. */
  SAVE_TRACKING_TAKE: 'tracking:save-take',
  /** Renderer → main (invoke): pick + copy media into the project's assets/<cat>/ → AssetEntry[]. */
  IMPORT_ASSETS: 'asset:import',
  /** Renderer → main (invoke): copy one already-known file into assets/<cat>/ → AssetEntry (e.g. a recorded take). */
  IMPORT_ASSET_FILE: 'asset:import-file',
  /** Renderer → main: reveal a file in the OS file manager. */
  SHOW_ITEM_IN_FOLDER: 'asset:show-in-folder',
  /** Renderer → main (invoke): which of these paths exist on disk → boolean[]. */
  ASSET_EXISTS: 'asset:exists',
  /** Renderer → main (invoke): pick a video file → absolute path. */
  PICK_VIDEO: 'app:pick-video',
  /** Renderer → main (invoke): pick/create a project folder → { root, projectFile }. */
  PROJECT_NEW_FOLDER: 'project:new-folder',
  /** Renderer → main (invoke): pick a project folder → { path, data } (paths resolved absolute). */
  PROJECT_OPEN_FOLDER: 'project:open-folder',
  /** Renderer → main (invoke): copy external assets into the project's assets/ → CollectResult. */
  PROJECT_COLLECT_ASSETS: 'project:collect-assets',
  /** Renderer → main (invoke): pick a fresh folder and collect a self-contained copy there (non-destructive). */
  PROJECT_COLLECT_TO: 'project:collect-to',
  /** Renderer → main (invoke): enumerate connected displays → DisplayInfo[]. */
  PROJECTOR_LIST_DISPLAYS: 'projector:list-displays',
  /** Renderer → main: open (or move) a surface's fullscreen output on a display. */
  PROJECTOR_OPEN: 'projector:open',
  /** Renderer → main: close a surface's projector output window. */
  PROJECTOR_CLOSE: 'projector:close',
  /** Renderer → main: move an open output to a different display. */
  PROJECTOR_SET_DISPLAY: 'projector:set-display',
  /** Main → renderer: hand off a MessagePort bridging main ↔ a projector window. */
  PROJECTOR_PORT: 'projector:port',
  /** Main → renderer: the set of connected displays changed (add/remove). */
  PROJECTOR_DISPLAYS_CHANGED: 'projector:displays-changed',
  /**
   * Main → renderer: a projector window was closed BY THE USER (its X button), not by the app.
   * Without this the renderer never learns the window is gone: the output stays `enabled`, its entry
   * stays in openProjectorsRef, and the reconciler — which only acts when the desired display
   * CHANGES — sees "already open" and never reopens it. The output became permanently dead until
   * someone toggled it off and on again, while the frame pump kept posting to the dead port.
   */
  PROJECTOR_CLOSED: 'projector:closed',
} as const;

export interface UpdateEvent {
  status: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error' | 'manual';
  version?: string;
  percent?: number;   // download-progress %
  message?: string;   // error detail
  url?: string;       // 'manual': where to download (unsupported platforms)
}

export interface AppInfo {
  name: string;
  version: string;
}

// Spout (SpoutConfig/SpoutFrame) → @artlux/plugin-spout; NDI (NdiConfig/NdiFrame/NdiSendConfig) →
// @artlux/plugin-ndi; HAP video (HapInfo/HapFrame) → @artlux/plugin-hap.

// ---- Projector calibration (native OpenCV addon: structured light + solvePnP) ----
// All point/matrix fields are flat plain-number arrays so the IPC payloads stay structured-cloneable
// and the same shapes serialize into ProjectorCalibration. The native addon (native/calib/calib.node,
// built off-host against OpenCV+LLVM like the NDI prebuilt) does the heavy CV; when it's absent the
// calibManager returns null and the UI shows "calibration addon unavailable".

// findChessboardCornersSB + cornerSubPix on one camera frame.
export interface BoardDetectResult {
  found: boolean;
  corners: number[]; // flat camera-space [x0,y0, x1,y1, …] (length cols*rows*2 when found)
}

// ArUco fiducial detection result: parallel arrays — ids[i] ↔ corners[i*8 .. i*8+8] (4 sub-pixel
// camera-pixel corners x,y in detector order). For one-click recalibration (see calib/markerlessController).
export interface ArucoDetection {
  ids: number[];
  corners: number[]; // 8 per id: [x0,y0, x1,y1, x2,y2, x3,y3] camera px
}

// One board pose's detected camera corners mapped to projector pixels via a decoded Gray-code
// sequence (local homography around each corner). `valid[i]` is 1 when the decode succeeded there.
export interface CornerProjMap {
  projCorners: number[]; // flat projector-space [u,v, …], aligned with the input camera corners
  valid: number[];       // 1/0 per corner
}

// calibrateCamera result for the projector (intrinsics + distortion).
export interface ProjectorIntrinsicsResult {
  k: number[];     // 9, row-major 3×3
  dist: number[];  // 5: k1,k2,p1,p2,k3
  rms: number;     // reprojection RMS (px)
}

// solvePnP result (pose in venue frame), intrinsics held fixed.
export interface PnpResult {
  rotation: number[];    // 9, row-major 3×3 (world→cam)
  translation: number[]; // 3
  rms: number;           // reprojection RMS (px)
}

// Dense camera-pixel → projector-pixel correspondences (markerless pipeline). camX/camY are camera
// pixels, projX/projY the decoded projector pixels — all aligned and subsampled by the requested stride.
// The renderer raycasts each (camX,camY) onto the venue mesh → a 3D point paired with (projX,projY)
// to resection the projector against the venue model (no board).
export interface DenseMap {
  camX: number[];
  camY: number[];
  projX: number[];
  projY: number[];
}

// Board-free camera (and bonus projector) intrinsics recovered from the structured-light scan by
// treating camera↔projector as an uncalibrated stereo pair (fundamental matrix → Bougnoux focal).
// `ok` is false when it fails the sanity gates (inliers/RMS/focal plausibility) — keep the nominal then.
export interface CameraSelfCal {
  camK: number[];   // 9 (empty when !ok)
  projK: number[];  // 9 (empty when !ok)
  ok: boolean;
  rms: number;      // Sampson epipolar RMS over inliers (px)
  inliers: number;
}

// One MPCDI region = one projector's warp + blend for interchange. `geo` is the per-projector-pixel 3D
// surface map (world XYZ) on a w×h grid (the geometry warp / PFM); `alpha` is the optional blend map
// (0..255 / PNG). MPCDI is the open standard for exchanging projector calibration with other media
// servers + projectors (see src/main/mpcdi.ts).
export interface MpcdiRegion {
  id: string;
  projW: number; projH: number;
  geo: { w: number; h: number; xyz: Float32Array };
  alpha?: { w: number; h: number; data: Uint8Array };
}

// One grayscale frame grabbed natively via OpenCV's DirectShow camera backend (CAP_DSHOW). Used for
// cameras Chromium's getUserMedia can't drive (e.g. the PS3 Eye's DirectShow source filter). `data`
// is a single-channel w*h luminance buffer, ready for detectBoard / mapCorners.
export interface CameraFrame {
  w: number;
  h: number;
  data: ArrayBuffer; // grayscale, w*h bytes
}

// ---- OSC (external control + LiDAR blob tracking) ----------------------------
// OscConfig / OscMessage now live in the (unstable, internal) plugin SDK because both the host
// and first-party plugins (the LiDAR tracking transport) speak this vocabulary. Imported for
// local use in this file's types and re-exported so existing `shared/protocol` import sites
// keep working unchanged.
import type { OscConfig, OscMessage } from '@artlux/sdk';
export type { OscConfig, OscMessage };

// One Art-Net node found via ArtPoll/ArtPollReply discovery.
export interface ArtNetDevice {
  ip: string;
  shortName: string;
  longName: string;
  mac?: string;
  oem?: number;
}

export interface InputConfig {
  enabled: boolean;
  protocol: 'artnet' | 'sacn' | 'both';
  universes: number[]; // sACN multicast groups to join
}

export interface InputFrame {
  protocol: 'artnet' | 'sacn';
  universe: number;
  data: number[];
}

export interface OutputConfig {
  ip: string;
  port: number;
  broadcast: boolean;
  fps?: number;       // native pacer rate
  keepAlive?: boolean; // re-send last frame on pacer timeout
  sync?: boolean;     // emit ArtSync (OpSync 0x5200) after each frame
}

export interface OutputStats {
  pps: number;        // packets/sec
  fps: number;        // frames/sec (incl. keep-alive)
  universes: number;  // universes in the last frame
}

// Renderer-side per-frame timing over a rolling window (services/perfMonitor). Distinct from
// OutputStats (the native Art-Net *pacer* rate): this measures how healthily the renderer's frame
// loop lands frames — the signal that actually tells apart smooth 60 fps from a periodic hitch, and
// how much work-time headroom is left for future features (e.g. a spatial-audio graph). Reported to
// main ~1 Hz so it can surface in Prometheus, since broadcast (show) mode has no on-screen HUD.
export interface RenderStats {
  fps: number;         // 1000 / median frame interval
  frameP50: number;    // ms — typical interval between frames
  frameP99: number;    // ms — worst-case interval (the jank tail)
  frameMax: number;    // ms — single worst interval in the window
  workP50: number;     // ms — typical work time spent inside a frame
  workP99: number;     // ms — worst-case in-frame work time
  longFrames: number;  // intervals in the window that overran the drop threshold (1.5× median)
  samples: number;     // frames observed in the window
}

export type OutputProtocol = 'artnet' | 'sacn';

// One routing destination: a controller and the universes destined for it.
export interface UniverseTarget {
  ip: string;
  port: number;
  protocol: OutputProtocol;
  broadcast: boolean; // Art-Net: UDP broadcast; sACN: multicast
  sparse: boolean;    // skip universes unchanged since last send
  priority?: number;  // sACN priority (default 100)
  universes: Record<number, number[]>;
}

export interface ArtNetFramePayload {
  targets: UniverseTarget[];
}

// ---- Projector outputs (per-Surface fullscreen → physical display) -----------

// A connected display, as reported by Electron's `screen` module (DIP coords).
export interface DisplayInfo {
  id: number;
  label: string;        // human-readable (built-in / resolution / index)
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;  // DPI scale (size the projector buffer by this for native res)
  primary: boolean;
  internal: boolean;
}

// Sentinel displayId for a WINDOWED output: a normal movable/resizable window on the primary screen
// instead of fullscreen on a physical display — for working/testing/calibrating on a single monitor.
export const WINDOWED_DISPLAY = -1;

// 4-corner homography (corner-pin). Each corner is a normalized [x, y] in the
// projector's display space (0..1, origin top-left). Identity = full-screen quad.
export interface CornerPin {
  tl: [number, number];
  tr: [number, number];
  br: [number, number];
  bl: [number, number];
}

export const defaultCornerPin = (): CornerPin => ({
  tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1],
});

// A tessellated render mesh: a (cols+1)×(rows+1) lattice of normalized display-space points
// (row-major). Produced on the fly from a BezierWarp; not persisted. ProjectorGL draws it as
// a triangle mesh sampling the content on a regular UV grid.
export interface WarpGrid {
  cols: number;
  rows: number;
  points: [number, number][];
}

// Bézier warp: a bicubic patch defined by a 4×4 control net of normalized display-space
// points (row-major, row 0 = top). The four patch corners (indices 0,3,12,15) are the
// projection corners; the 12 edge/interior points bend the surface smoothly for curved
// screens. When set it supersedes the corner-pin. Default net = the corner-pin quad (flat).
export interface BezierWarp {
  points: [number, number][]; // length 16
}

// A normalized sub-rectangle of a source image ([0,1], top-left origin). Used to crop one
// surface's content into a SLICE surface — see OutputSpan and renderer/types SurfaceContent.
export interface SrcRect { x: number; y: number; w: number; h: number }

export const FULL_RECT: SrcRect = { x: 0, y: 0, w: 1, h: 1 };

// Per-output soft-edge blend (for overlapping projectors). Each value is the feather width
// as a fraction of the output (0 = hard edge).
//
// ⚠ `gamma` IS THE PROJECTOR'S GAMMA, and the ramp is `alpha^(1/gamma)` — not `alpha^gamma`.
// The screen emits `signal^gamma`, so only the inverse exponent makes the emitted LIGHT ramp
// linearly, which is the whole point: two projectors feathering into each other must sum to
// exactly 1 at every point of the overlap. It was `pow(a, gamma)` until 2026-07-21, which put
// 2·0.5^2.2 ≈ 0.07 of full light in the middle of every seam — a black band precisely where the
// blend was supposed to be invisible. Fixed in ProjectorGL's FRAG; the field name and its 2.2
// default are unchanged, so no project migrates, but a show that already used soft edge looks
// different (correct) now. Measure the real value with Outputs → Auto-measure (camera).
export interface SoftEdge {
  left: number;
  right: number;
  top: number;
  bottom: number;
  gamma: number;
}

export const defaultSoftEdge = (): SoftEdge => ({ left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 });

// Recovered physical-projector calibration (the projector is an inverse camera). Intrinsics +
// distortion come from structured light (Moreno-Taubin: camera watches Gray-code on a checkerboard);
// pose comes from solvePnP over operator-aimed crosshair ↔ venue-model-pick correspondences. Once
// solved, the matching virtual projector renders the 3D scene from the real projector's viewpoint
// (true projection mapping). All vectors are flat row-major arrays so the file stays plain-JSON.
export interface ProjectorCalibration {
  intrinsics: number[];   // K, row-major 3×3 [fx,0,cx, 0,fy,cy, 0,0,1] (structured light)
  distortion: number[];   // [k1,k2,p1,p2,k3] radial+tangential (structured light)
  rotation: number[];     // R world→cam, row-major 3×3 (solvePnP)
  translation: number[];  // t world→cam, length 3 (solvePnP)
  imageSize: [number, number]; // projector raster the pixels were captured in
  intrinsicsRms?: number;      // structured-light reprojection RMS (px)
  poseRms?: number;            // solvePnP reprojection RMS (px)
  // Editable pose correspondences (projector pixel ↔ venue-model world point), kept so a moved
  // projector can re-solve pose without redoing structured light.
  posePicks?: Array<{ world: [number, number, number]; pixel: [number, number] }>;
  calibratedAt?: string;       // ISO timestamp
}

// One Surface routed to a physical projector as its own fullscreen output.
export interface ProjectorOutput {
  surfaceId: string;
  enabled: boolean;
  displayId: number | null;   // Electron display.id (session-stable)
  displayLabel?: string;      // fallback re-match across replug/reboot
  cornerPin: CornerPin;       // 4-corner homography warp onto the projection
  warp?: BezierWarp | null;   // optional bicubic Bézier warp (supersedes cornerPin when set)
  softEdge?: SoftEdge;        // edge blending for projector overlap
  gamma?: number;             // per-output output gamma (1 = off)
  ndiSend?: boolean;          // also publish this output as an NDI source
  calibration?: ProjectorCalibration | null; // recovered intrinsics+distortion+pose (render-from-projector)
  useCalibration?: boolean;   // when calibrated, render the 3D venue scene from the matched projector
  hwWarp?: boolean;           // apply warp+blend at the GPU scanout via NVAPI (Quadro/RTX-pro) instead
                              // of the GLSL path; ignored unless nvwarpAvailable() and a real display
  projMask?: ProjMask;        // exclusion polygons (normalized content space) — constrain projection
  colorGain?: [number, number, number]; // per-channel white-point/brightness match across projectors (1,1,1 = off)
  blackLift?: [number, number, number]; // per-channel additive black floor to match overlap black (0 = off)
}

// Projector exclusion mask: polygons in normalized content space ([0,1], top-left origin). Pixels
// inside any polygon are blacked out (limit projection to the screen, kill spill onto floor/ceiling).
export interface ProjMask { polys: [number, number][][] }

export const defaultProjectorOutput = (surfaceId: string): ProjectorOutput => ({
  surfaceId, enabled: false, displayId: null, cornerPin: defaultCornerPin(),
  warp: null, softEdge: defaultSoftEdge(), gamma: 1,
});

// ── Spanning one source across several projectors ────────────────────────────────────────────────
// A span is AUTHORING METADATA over a set of ordinary surfaces, not a runtime object. It records how
// a grid of SLICE surfaces was cut out of one source surface so the operator can re-tune the overlap
// later instead of re-typing sixteen numbers. The truth always lives on the members themselves
// (SurfaceContent.sliceRect + the outputs' SoftEdge) — regenerating just overwrites them, so a span
// whose members were hand-tuned, renamed or deleted still degrades to something sane.
//
// It is deliberately project-level, not per-scene: a scene recall swaps surfaces + projectorOutputs,
// and a span pointing at ids from another scene must not fight that. Dangling ids are ignored.
export interface OutputSpan {
  id: string;
  name: string;
  sourceSurfaceId: string;    // the surface being split (video / PROGRAM / effect / …)
  cols: number;
  rows: number;
  overlapX: number;           // fraction of ONE tile's width shared with its horizontal neighbour (0..0.5)
  overlapY: number;           // same, vertically
  sliceIds: string[];         // member Surface ids, row-major (length cols*rows)
  linked: boolean;            // true = editing cols/rows/overlap regenerates the members' rect + soft edge
}

export const defaultOutputSpan = (id: string, sourceSurfaceId: string, name: string): OutputSpan => ({
  id, name, sourceSurfaceId, cols: 2, rows: 1, overlapX: 0.12, overlapY: 0.12, sliceIds: [], linked: true,
});

// ---- Persistence (project / rig / preferences) -------------------------------

// An object placed in the 3D scene; transformed independently. Either a GLB mesh
// (kind 'mesh', from `path`) or a flat plane primitive (kind 'plane') that can display
// a timeline video layer (`layerId`) as a screen/projection.
export interface SceneModel {
  id: string;
  name: string;
  kind?: 'mesh' | 'plane';            // default 'mesh' (back-compat)
  path: string;                       // GLB/glTF file path (mesh); '' for planes
  layerId?: string;                   // plane: which timeline track to show
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number }; // degrees
  scale: number;                      // uniform (1 = GLB units are meters); legacy fallback
  scaleXYZ?: [number, number, number]; // per-axis scale; when set it supersedes `scale`
  visible: boolean;
}

// Effective per-axis scale for a model: the per-axis vector when set, else the uniform `scale`.
export const modelScaleXYZ = (m: { scale: number; scaleXYZ?: [number, number, number] }): [number, number, number] => {
  if (m.scaleXYZ) return [m.scaleXYZ[0] || 0.0001, m.scaleXYZ[1] || 0.0001, m.scaleXYZ[2] || 0.0001];
  const s = m.scale > 0 ? m.scale : 1;
  return [s, s, s];
};

// 3D Scene config (venue meshes + lighting), persisted per project.
// Camera exclusion mask for markerless calibration: polygons (camera-pixel coords) over reflective
// hotspots / obstructions whose pixels are dropped from the Gray-code decode. See renderer/calib/camMask.ts.
export interface CamMask {
  w: number;                      // camera width the polygons were drawn against
  h: number;                      // camera height
  polys: [number, number][][];    // exclusion polygons; each ≥3 [x,y] camera pixels
}

// A fiducial (ArUco) marker placed in the venue at a known 3D point, registered once. Used for
// one-click recalibration: the camera detects the marker → its id → this 3D point → camera pose.
export interface FiducialMarker { id: number; world: [number, number, number] }
export interface MarkerMap {
  dict: number;                  // ArUco predefined-dictionary id (e.g. 0 = DICT_4X4_50)
  markers: FiducialMarker[];
}

// Floor calibration for camera pose tracking (@artlux/plugin-mediapipe): a 4-point homography relating
// the webcam image to a real floor rectangle. `imageQuad` are the four floor-rectangle corners marked in
// the live feed — normalized [u,v] in [0..1], origin BOTTOM-LEFT (matching the pose landmark space) — in
// {tl,tr,br,bl} logical order. width/depth are the rectangle's real size (metres). The plugin composes
// the image→floor homography from these; a plane needs only 4 points, so no camera intrinsics are stored.
export interface MediapipeFloor {
  imageQuad: [[number, number], [number, number], [number, number], [number, number]]; // tl, tr, br, bl
  width: number;                 // floor rectangle width (x), metres
  depth: number;                 // floor rectangle depth (z), metres
}

export interface Scene3D {
  models: SceneModel[];
  lightIntensity: number;             // per-fixture venue light gain
  environment: boolean;               // ambient/HDR base lighting
  exposure: number;                   // tone-mapping exposure
  gridVisible: boolean;
  reflectiveFloor?: boolean;          // mirror floor reflecting the LEDs/meshes
  trackingViz?: boolean;              // overlay the LiDAR SOL/MUR zones + live blob markers
  trackingSmoothing?: number;         // 0 = raw, 1 = heavy (One-Euro min-cutoff)
  trackingPredictMs?: number;         // blob prediction horizon, ms (0 = off)
  trackingLabels?: boolean;           // show each blob's tracking id
  trackingMergePeople?: boolean;      // merge nearby blobs into one "person" (venue emits 2 blobs/person)
  trackingMergeRadius?: number;       // merge radius in metres (blobs within this distance = same person)
  mediapipeViz?: boolean;             // overlay the camera-pose (MediaPipe) tracked-people markers in 3D
  mediapipeFloor?: MediapipeFloor;    // camera→floor homography for real-world pose position preview
  augmentaViz?: boolean;              // overlay the Augmenta field + tracked-object markers in 3D (@artlux/plugin-augmenta)
  camMask?: CamMask;                  // markerless calibration camera exclusion mask (reflective hotspots)
  markerMap?: MarkerMap;              // registered fiducial markers for one-click recalibration
  // Legacy single-model fields (pre-multi-model); migrated into `models` on load.
  modelPath?: string;
  modelScale?: number;
  modelPosition?: { x: number; y: number; z: number };
  modelRotation?: { x: number; y: number; z: number };
}

export const defaultScene3D = (): Scene3D => ({
  models: [],
  lightIntensity: 1,
  environment: true,
  exposure: 1,
  gridVisible: true,
  reflectiveFloor: false,
  trackingViz: false,
  augmentaViz: false,
  trackingSmoothing: 0.6,
  trackingPredictMs: 50,
  trackingLabels: true,
  trackingMergePeople: false,
  trackingMergeRadius: 0.8,
});

// ---- Asset library -----------------------------------------------------------
// A managed media library entry. Files are copied into the project's assets/<cat>/ on import
// (path is relative on disk, resolved absolute on load like every other asset path). Recorded
// LiDAR takes are entries of type 'take' (path = the .lblob sidecar). Unused entries persist.
export type AssetType = 'video' | 'image' | 'model' | 'take' | 'audio';
export interface AssetEntry {
  id: string;
  name: string;
  type: AssetType;
  path: string;            // assets/<cat>/<file> (absolute in memory, relative on disk)
  size?: number;           // bytes
  durationSec?: number;    // video / take
  fps?: number;            // take
  width?: number;          // video / image
  height?: number;
  channels?: number;       // audio channel count
  addedAt?: string;        // ISO timestamp
}

// Full project file (kept loose here so shared/ stays decoupled from renderer types).
// Asset paths inside surfaces/scene3D/timeline are stored relative to the project
// folder when collected (see main/projectFolder.ts), and resolved to absolute on load.
export interface ProjectData {
  version: string;
  timestamp?: string;
  fixtures: unknown[];
  surfaces?: unknown[];     // Surface[] (renderer type) — carries VIDEO/IMAGE asset urls
  controllers?: unknown[];
  // `settings` REMOVED (P6): AppSettings is the machine, not the show — it lives in Prefs.appSettings.
  // Legacy files still carry the key; it is ignored on load. See App.tsx applyProjectData.
  globalBrightness: number;
  groups: unknown[];
  scenes: unknown[];
  cueBanks?: unknown[]; // CueBank[] (renderer type) — granular cue grid; row 0 references scenes
  scene3D?: Scene3D;
  timeline?: unknown; // Timeline (renderer type) — video-layer NLE
  stateMachine?: unknown; // StateMachine (renderer type) — project-level show graph over scenes
  schedule?: unknown[]; // ScheduleEntry[] (@artlux/plugin-show-control) — in-project wall-clock triggers
  audio?: unknown; // AudioMix (renderer type) — global audio bed (Wave 3); normalizeAudioMix() on read
  assets?: AssetEntry[]; // managed media library (video/image/model/take/audio)
  projectorOutputs?: ProjectorOutput[]; // per-surface fullscreen projector mappings
  outputSpans?: OutputSpan[]; // authoring metadata: how a source surface was cut into SLICE surfaces
  projectorFpsCap?: number; // performance mode: cap projector output fps (0 = uncapped/vsync)
  projectorBrightness?: number; // master brightness of projected content (1 = full)
  reserveLockedRanges?: boolean; // patch policy: pack auto fixtures AROUND locked ranges (was AppSettings)
}

// Result of a "Collect Assets" run.
export interface CollectResult {
  data: ProjectData;     // remapped project (asset paths now point into assets/, still absolute)
  copied: number;        // files copied into assets/
  skipped: number;       // references already collected / not collectable
  missing: string[];     // source paths that no longer exist on disk
}

// Result of creating a new project folder.
export interface NewProjectFolder {
  root: string;          // the project folder
  projectFile: string;   // <root>/project.artlux
}

// A reusable rig: fixtures with patch/wiring/routing only (no scenes/media/effects).
export interface RigData {
  version: string;
  kind: 'rig';
  fixtures: unknown[];
}

// Persisted across launches in userData.
export interface Prefs {
  appSettings?: unknown;
  globalBrightness?: number;
  recentFiles: string[];
  lastProjectPath?: string;
  fixtureTemplates?: unknown[]; // saved fixture library (S4)
  /** Per-modal drag offset (px translate from centered), keyed by a stable modal id.
      Workspace ergonomics — persisted in prefs (not the project) so it survives restarts. */
  modalPositions?: Record<string, { x: number; y: number }>;
  /** Main-window UI zoom factor (0.8–2.0). Applied via webContents.setZoomFactor; scales the whole
      editor chrome. First-run default is auto-detected from the primary display; the user overrides it. */
  uiScale?: number;
  /** Serialized editor layout (panel sizes/visibility/tabs + active preset). Renderer-owned blob —
      typed as WorkspaceLayout in the renderer; kept `unknown` here like appSettings. */
  layoutState?: unknown;
  /** Unattended self-healing watchdog config (broadcast/show installs). Absent = defaults, disabled. */
  unattended?: UnattendedPrefs;
}

// ─── Unattended watchdog (self-healing for broadcast/show installs) ────────────────────────────
// Tier-1 (in-app) detects renderer/GPU crash, hang, render-loop stall, and sustained output-down and
// does a full leak-safe process relaunch into the current --broadcast --project=…. A circuit breaker
// caps relaunches so a crash-on-launch can't storm. Tier-2 (a Windows Scheduled Task) relaunches the
// whole app if the process dies entirely. See docs/WATCHDOG.md.
export interface UnattendedPrefs {
  enabled: boolean;              // master watchdog on/off
  crashRecovery: boolean;        // Tier-1 crash/hang/GPU recovery (webContents listeners)
  outputDownSec: number;         // relaunch if Art-Net output has been down this long (fps==0)
  renderStallSec: number;        // relaunch if no renderer heartbeat for this long (frozen tick)
  minRelaunchGapSec: number;     // never relaunch more often than this (debounce)
  maxRelaunchesPerHour: number;  // circuit breaker: after N in a rolling hour, give up + mark tripped
  always?: boolean;              // arm the watchdog even outside --broadcast (default: broadcast only)
}

// A single watchdog detection/recovery record; appended to the userData event log and shown on the
// tablet Metrics tab so an unattended run can be audited after the fact.
export interface WatchdogEvent {
  ts: number;      // epoch ms
  mode: string;    // editor | broadcast | headless (process launch mode)
  project: string; // loaded project path at the time (or '')
  trigger: string; // startup | render-process-gone | gpu-gone | unresponsive | render-stall | output-down | tripped
  detail: string;  // human-readable specifics (crash reason, seconds down, …)
  action: string;  // relaunch | skipped-debounce | tripped | none
  outcome: string; // ok | an error string
}

export interface WatchdogStatus {
  enabled: boolean;           // watchdog armed this session (pref on AND mode gate satisfied)
  tripped: boolean;           // circuit breaker engaged — no more auto-relaunches until reset
  relaunchesLastHour: number; // rolling count feeding the breaker
  taskInstalled: boolean;     // Tier-2 Scheduled Task present (Windows; false elsewhere)
  recent: WatchdogEvent[];    // most-recent-first, tail of the persistent log
}

export interface OpenProjectResult {
  path: string;
  data: ProjectData;
}

// ── Workspace contexts, as the two menus see them ───────────────────────────────────────────────
// The rail is built from the renderer's `contextRegistry`, but a MENU cannot be: the native menu lives
// in the main process and has no access to a renderer registry. Both menus therefore read this ONE
// list, so the app-styled menu bar and the native menu can never drift (they mirror each other by
// design — see the note atop components/MenuBar.tsx).
//
// Ctrl+1..9 are shown here but NOT registered as accelerators: the rail's own keydown handler owns
// them, so it can ignore them while the operator is typing in a numeric field. Menu entries pass
// through, exactly like the existing `passthrough` items.
//
// A context registered by a PLUGIN appears on the rail and in the command palette but not here —
// menus in this app are static by construction. Core's ten are the ones worth a menu entry.
export interface ContextMenuEntry { id: string; label: string; accel?: string; sepBefore?: boolean }
export const CONTEXT_MENU_ITEMS: ContextMenuEntry[] = [
  { id: 'timeline', label: 'Timeline',           accel: 'Ctrl+1' },
  { id: 'mapping',  label: 'Mapping',            accel: 'Ctrl+2' },
  { id: '3d',       label: 'Venue / 3D Scene',   accel: 'Ctrl+3' },
  { id: 'project',  label: 'Projection Outputs', accel: 'Ctrl+4', sepBefore: true },
  { id: 'calib',    label: 'Calibration',        accel: 'Ctrl+5' },
  { id: 'scenes',   label: 'Scenes & Cues',      accel: 'Ctrl+6', sepBefore: true },
  { id: 'machine',  label: 'Show Machine',       accel: 'Ctrl+7' },
  { id: 'audio',    label: 'Audio',              accel: 'Ctrl+8' },
  { id: 'tracking', label: 'Tracking',           accel: 'Ctrl+9' },
  { id: 'show',     label: 'Show / Perform' },
];
/** The menu action a context entry fires; App routes it through goToContext. */
export const contextAction = (id: string): string => `context:${id}`;

/** Window/menu-role commands the custom title bar can fire at the main window. */
export type WindowCommand =
  | 'minimize' | 'maximize-toggle' | 'close' | 'quit'
  | 'reload' | 'devtools' | 'fullscreen'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'cut' | 'copy' | 'paste' | 'select-all';

/** API surface exposed on `window.artlux` by the preload via contextBridge. */
/** In-app Docs Browser tree. One section per example set (+ the user guide); each entry is one page. */
export interface DocEntry { id: string; title: string; }
export interface DocSection { id: string; title: string; entries: DocEntry[]; }
/** One doc's rendered source + its absolute directory (for resolving sibling images / .artlux links). */
export interface DocContent { markdown: string; dir: string; }
/** Raw bytes + MIME of a doc-referenced image, read from disk in main (renderer wraps it in a Blob). */
export interface DocAsset { mime: string; data: Uint8Array; }

export interface ArtluxApi {
  configureOutput(cfg: OutputConfig): void;
  /** One frame, encoded by shared/frameCodec.encodeFrame (binary handoff). */
  sendArtNet(frame: ArrayBuffer): void;
  onStatus(cb: (connected: boolean) => void): () => void;
  onDmxStats(cb: (stats: OutputStats) => void): () => void;
  /** Renderer → main: push ~1 Hz renderer frame-time stats for the Prometheus endpoint. */
  reportRenderStats(stats: RenderStats): void;
  configureInput(cfg: InputConfig): void;
  onDmxInput(cb: (frames: InputFrame[]) => void): () => void;
  // Persistence
  saveProject(data: ProjectData, path?: string): Promise<string | null>;
  openProject(): Promise<OpenProjectResult | null>;
  loadProjectPath(path: string): Promise<ProjectData | null>;
  // Portable projects (folder + asset collection)
  newProjectFolder(): Promise<NewProjectFolder | null>;
  openProjectFolder(): Promise<OpenProjectResult | null>;
  collectAssets(projectFile: string, data: ProjectData): Promise<CollectResult | null>;
  /** Pick a fresh folder and collect a self-contained copy there (leaves the current project untouched). */
  collectAssetsTo(data: ProjectData): Promise<(CollectResult & { projectFile: string }) | null>;
  exportRig(rig: RigData): Promise<string | null>;
  importRig(): Promise<RigData | null>;
  getPrefs(): Promise<Prefs>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  /** Clamp to [0.8, 2.0], persist to Prefs.uiScale, and apply to the main window immediately. */
  setUiScale(scale: number): Promise<void>;
  /** First-run default UI scale computed from the primary display (physical px vs OS scale). */
  detectUiScale(): Promise<number>;
  discoverDevices(): Promise<ArtNetDevice[]>;
  // Spout + NDI (video receive) moved to their plugins (generic pluginInvoke/Send/On bridge).
  // OSC (external control + LiDAR tracking) — receive-first; send is a scaffold.
  configureOsc(cfg: OscConfig): void;
  onOscMessage(cb: (msgs: OscMessage[]) => void): () => void;
  sendOsc(host: string, port: number, address: string, args: (number | string)[]): void;
  listLocalAddrs(): Promise<string[]>;
  // HAP video + projector calibration moved to their plugins (generic pluginInvoke/Send bridge).
  /** Is the NVAPI scanout warp/blend addon available (Quadro/RTX-pro)? Else use the GLSL fallback. */
  nvwarpAvailable(): Promise<boolean>;
  /** Push a scanout warp mesh (verts = numVerts*6 XYUVRQ; src = [x,y,w,h]) to an Electron display. */
  nvwarpSetWarp(electronDisplayId: number, verts: number[], src: number[]): Promise<boolean>;
  /** Push a scanout intensity/blend map (w*h*3 RGB, 0..1) to an Electron display. */
  nvwarpSetIntensity(electronDisplayId: number, w: number, h: number, rgb: number[]): Promise<boolean>;
  /** Clear scanout warp + intensity from an Electron display. */
  nvwarpClear(electronDisplayId: number): void;
  /** Export projector warp+blend regions as an .mpcdi file (save dialog) → path, or null if cancelled. */
  exportMpcdi(regions: MpcdiRegion[]): Promise<string | null>;
  /** Import an .mpcdi file (open dialog) → regions, or null if cancelled/failed. */
  importMpcdi(): Promise<MpcdiRegion[] | null>;
  // App chrome
  onMenuAction(cb: (action: string) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): void;
  /** Save-then-relaunch into broadcast mode (no editor UI; outputs + Art-Net only). */
  relaunchBroadcast(projectPath: string): void;
  // Unattended watchdog (self-healing for broadcast/show installs — see docs/WATCHDOG.md)
  /** Current watchdog arming state + circuit-breaker status + tail of the self-heal event log. */
  getWatchdogStatus(): Promise<WatchdogStatus>;
  /** Install the Tier-2 OS supervisor (Windows Scheduled Task). Needs elevation; returns a result. */
  installWatchdogTask(): Promise<{ ok: boolean; message: string }>;
  /** Remove the Tier-2 OS supervisor task. */
  uninstallWatchdogTask(): Promise<{ ok: boolean; message: string }>;
  /** Live push of each watchdog detection/recovery event (for the audit UI). */
  onWatchdogEvent(cb: (e: WatchdogEvent) => void): () => void;
  // Custom title bar (frameless window): window controls + menu roles.
  windowCommand(cmd: WindowCommand): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximizeChanged(cb: (maximized: boolean) => void): () => void;
  // Auto-update (user-gated: nothing downloads or installs without an explicit call)
  checkForUpdates(): void;
  downloadUpdate(): void;
  installUpdate(): void;
  onUpdate(cb: (e: UpdateEvent) => void): () => void;
  // 3D model import (used by the embedded 3D scene panel).
  pickModel(): Promise<string | null>;
  readModel(path: string): Promise<Uint8Array | null>;
  // Generic file access (timeline video clips)
  readFile(path: string): Promise<Uint8Array | null>;
  // In-app Docs Browser (examples/tutorials + user guide)
  docsList(): Promise<DocSection[]>;
  docsRead(id: string): Promise<DocContent | null>;
  /** Read a sibling image referenced by a doc (absolute path, validated under the docs roots). */
  docsReadAsset(absPath: string): Promise<DocAsset | null>;
  /** Open (or focus) the detached Docs & Tutorials window, optionally at a doc id. */
  openDocsWindow(id?: string): void;
  /** From the detached Docs window: load an example project into the main editor window. */
  docsOpenExample(absPath: string): void;
  pickVideo(): Promise<string | null>;
  /** Write a recorded LiDAR-blob take (JSON) to a sidecar `.lblob` file → absolute path. */
  saveTrackingTake(id: string, json: string): Promise<string | null>;
  // Asset library
  /** Pick media files of a category and copy them into the project's assets/ → AssetEntry[]. */
  importAssets(projectFile: string, type: AssetType): Promise<AssetEntry[]>;
  /** Copy a known file into the project's assets/ as an asset of `type` → AssetEntry (or null). */
  importAssetFile(projectFile: string, srcPath: string, type: AssetType, name?: string): Promise<AssetEntry | null>;
  /** Reveal a file in the OS file manager. */
  showItemInFolder(path: string): void;
  /** Which of these paths exist on disk. */
  assetExists(paths: string[]): Promise<boolean[]>;
  /** Resolve a dropped File to its absolute path (Electron webUtils). */
  getPathForFile(file: File): string;
  // Projector outputs (per-surface fullscreen on a physical display). The bridge
  // MessagePort arrives via a window 'artlux:projector-port' message (preload), not here.
  listDisplays(): Promise<DisplayInfo[]>;
  openProjector(surfaceId: string, displayId: number): void;
  closeProjector(surfaceId: string): void;
  setProjectorDisplay(surfaceId: string, displayId: number): void;
  onDisplaysChanged(cb: (displays: DisplayInfo[]) => void): () => void;
  /** A projector window was closed by the user (window X), so the renderer can drop its state. */
  onProjectorClosed(cb: (surfaceId: string) => void): () => void;
  // Generic plugin IPC bridge (channels namespaced under 'plugin:<channel>' by preload). First-party
  // plugins use these to talk to their own main-process entry without bespoke preload methods.
  pluginInvoke(channel: string, ...args: unknown[]): Promise<unknown>;
  pluginSend(channel: string, ...args: unknown[]): void;
  pluginOn(channel: string, cb: (...args: unknown[]) => void): () => void;
}

declare global {
  interface Window {
    artlux?: ArtluxApi;
  }
}
