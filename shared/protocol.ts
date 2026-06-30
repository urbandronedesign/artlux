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
  /** Renderer → main (invoke): ArtPoll broadcast → discovered Art-Net nodes. */
  ARTNET_DISCOVER: 'artnet:discover',
  /** Renderer → main (invoke): list available Spout sender names. */
  SPOUT_LIST: 'spout:list',
  /** Renderer → main: connect/disconnect the Spout receiver. */
  SPOUT_CONFIGURE: 'spout:configure',
  /** Main → renderer: a received Spout frame (downscaled 512² RGBA). */
  SPOUT_FRAME: 'spout:frame',
  /** Renderer → main (invoke): is the NDI runtime available? */
  NDI_AVAILABLE: 'ndi:available',
  /** Renderer → main (invoke): discover NDI sources on the network. */
  NDI_LIST: 'ndi:list',
  /** Renderer → main: connect/disconnect the NDI receiver. */
  NDI_CONFIGURE: 'ndi:configure',
  /** Main → renderer: a received NDI frame (downscaled RGBA). */
  NDI_FRAME: 'ndi:frame',
  /** Renderer → main: create/destroy a per-output NDI sender. */
  NDI_SEND_CONFIGURE: 'ndi:send-configure',
  /** Renderer → main: one captured frame for a per-output NDI sender (RGBA). */
  NDI_SEND_FRAME: 'ndi:send-frame',
  /** Renderer → main: enable/disable the OSC UDP listener (external control + LiDAR tracking). */
  OSC_CONFIGURE: 'osc:configure',
  /** Main → renderer: a batch of received OSC messages (one UDP packet → 1+ messages). */
  OSC_MESSAGE: 'osc:message',
  /** Renderer → main: send one OSC message to a target host:port (send scaffold). */
  OSC_SEND: 'osc:send',
  /** Renderer → main (invoke): list this machine's local IPv4 addresses (for NIC binding). */
  OSC_LOCAL_ADDRS: 'osc:local-addrs',
  /** Renderer → main (invoke): open a HAP-coded .mov; returns stream info or null if not HAP. */
  HAP_OPEN: 'hap:open',
  /** Renderer → main (invoke): decode one frame by index → RGBA (frame-accurate pull). */
  HAP_DECODE: 'hap:decode',
  /** Renderer → main: release a HAP source (by file path). */
  HAP_CLOSE: 'hap:close',
  /** Renderer → main (invoke): is the native OpenCV calibration addon present? */
  CALIB_AVAILABLE: 'calib:available',
  /** Renderer → main (invoke): detect a checkerboard in a camera frame → sub-pixel corners. */
  CALIB_DETECT_BOARD: 'calib:detect-board',
  /** Renderer → main (invoke): detect ArUco fiducials in a camera frame → ids + corners (one-click recal). */
  CALIB_DETECT_ARUCO: 'calib:detect-aruco',
  /** Renderer → main (invoke): map detected board corners to projector pixels via a captured Gray-code sequence. */
  CALIB_MAP_CORNERS: 'calib:map-corners',
  /** Renderer → main (invoke): calibrateCamera over all board poses → projector intrinsics + distortion. */
  CALIB_CALIBRATE_PROJECTOR: 'calib:calibrate-projector',
  /** Renderer → main (invoke): solvePnP (intrinsics fixed) → projector pose in venue frame. */
  CALIB_SOLVE_PNP: 'calib:solve-pnp',
  /** Renderer → main (invoke): open a calibration camera via OpenCV's DirectShow backend (by index). */
  CALIB_CAMERA_OPEN: 'calib:camera-open',
  /** Renderer → main (invoke): grab one grayscale frame from the open OpenCV camera. */
  CALIB_CAMERA_GRAB: 'calib:camera-grab',
  /** Renderer → main (invoke): grab one RGBA frame from the open OpenCV camera (colour preview). */
  CALIB_CAMERA_GRAB_COLOR: 'calib:camera-grab-color',
  /** Renderer → main: release the open OpenCV camera. */
  CALIB_CAMERA_CLOSE: 'calib:camera-close',
  /** Renderer → main (invoke): set a camera capture property (exposure/gain/gamma/wb/focus/…) on the open camera. */
  CALIB_CAMERA_SET_PROP: 'calib:camera-set-prop',
  /** Renderer → main (invoke): read a camera capture property's current value (to seed the UI). */
  CALIB_CAMERA_GET_PROP: 'calib:camera-get-prop',
  /** Renderer → main (invoke): dense camera→projector decode (markerless correspondences). */
  CALIB_DECODE_DENSE: 'calib:decode-dense',
  /** Renderer → main (invoke): RANSAC solvePnP (robust pose). */
  CALIB_SOLVE_PNP_RANSAC: 'calib:solve-pnp-ransac',
  /** Renderer → main (invoke): guided projector resection (intrinsic guess + degeneracy flags). */
  CALIB_CALIBRATE_GUIDED: 'calib:calibrate-guided',
  /** Renderer → main (invoke): board-free camera intrinsics from the scan (focal-from-F / Bougnoux). */
  CALIB_SELF_CALIBRATE: 'calib:self-calibrate',
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

export interface SpoutConfig {
  enabled: boolean;
  name?: string; // empty/undefined = active sender
}

export interface SpoutFrame {
  width: number;
  height: number;
  data: Uint8Array; // RGBA (downscaled to width×height)
  srcWidth: number;  // sender's true resolution (for stage aspect)
  srcHeight: number;
}

// NDI receive (network video) — same shape as Spout. `data` is RGBA downscaled to
// width×height; src* is the source's true resolution (for stage aspect).
export interface NdiConfig {
  enabled: boolean;
  name?: string; // empty/undefined = first discovered source
}

export interface NdiFrame {
  width: number;
  height: number;
  data: Uint8Array;
  srcWidth: number;
  srcHeight: number;
}

// HAP video — a HAP-coded .mov decoded natively in the main process (no hardware video-decode
// session). The renderer pulls the exact frame for the current playhead by index (all-intra,
// so any frame decodes independently — ideal for scrubbing) and paints the RGBA onto a canvas
// that renders through the same drawable path as Spout/NDI. Keyed by file path.
export interface HapInfo {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  codec: string;     // fourcc: Hap1 (DXT1) / Hap5 (DXT5) / HapY (scaled YCoCg) / HapA / HapM
  hasAlpha: boolean;
}

// A decoded HAP frame as raw GPU blocks (uploaded as a compressed texture in the renderer —
// the GPU decompresses, so this is ~8× smaller than RGBA over IPC).
export interface HapFrame {
  width: number;
  height: number;
  format: string;    // "dxt1" | "dxt5" | "ycocg" | "rgtc1" | "bptc"
  data: Uint8Array;  // raw BC/DXT block bytes
}

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

// NDI send — create/destroy a named NDI source for one projector output.
export interface NdiSendConfig {
  outputId: string;   // the surfaceId of the output
  enabled: boolean;
  name?: string;      // NDI source name (defaults to the surface name)
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

// Per-output soft-edge blend (for overlapping projectors). Each value is the feather width
// as a fraction of the output (0 = hard edge); gamma shapes the blend ramp.
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
export type AssetType = 'video' | 'image' | 'model' | 'take';
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
  settings: unknown;
  globalBrightness: number;
  groups: unknown[];
  scenes: unknown[];
  cueBanks?: unknown[]; // CueBank[] (renderer type) — granular cue grid; row 0 references scenes
  scene3D?: Scene3D;
  timeline?: unknown; // Timeline (renderer type) — video-layer NLE
  stateMachine?: unknown; // StateMachine (renderer type) — project-level show graph over scenes
  assets?: AssetEntry[]; // managed media library (video/image/model/take)
  projectorOutputs?: ProjectorOutput[]; // per-surface fullscreen projector mappings
  projectorFpsCap?: number; // performance mode: cap projector output fps (0 = uncapped/vsync)
  projectorBrightness?: number; // master brightness of projected content (1 = full)
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
}

export interface OpenProjectResult {
  path: string;
  data: ProjectData;
}

/** Window/menu-role commands the custom title bar can fire at the main window. */
export type WindowCommand =
  | 'minimize' | 'maximize-toggle' | 'close' | 'quit'
  | 'reload' | 'devtools' | 'fullscreen'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset'
  | 'cut' | 'copy' | 'paste' | 'select-all';

/** API surface exposed on `window.artlux` by the preload via contextBridge. */
export interface ArtluxApi {
  configureOutput(cfg: OutputConfig): void;
  /** One frame, encoded by shared/frameCodec.encodeFrame (binary handoff). */
  sendArtNet(frame: ArrayBuffer): void;
  onStatus(cb: (connected: boolean) => void): () => void;
  onDmxStats(cb: (stats: OutputStats) => void): () => void;
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
  exportRig(rig: RigData): Promise<string | null>;
  importRig(): Promise<RigData | null>;
  getPrefs(): Promise<Prefs>;
  setPrefs(patch: Partial<Prefs>): Promise<void>;
  discoverDevices(): Promise<ArtNetDevice[]>;
  // Spout
  listSpoutSenders(): Promise<string[]>;
  configureSpout(cfg: SpoutConfig): void;
  onSpoutFrame(cb: (frame: SpoutFrame) => void): () => void;
  // NDI (network video) — receive onto a surface + send a projector output
  ndiAvailable(): Promise<boolean>;
  listNdiSources(): Promise<string[]>;
  configureNdi(cfg: NdiConfig): void;
  onNdiFrame(cb: (frame: NdiFrame) => void): () => void;
  configureNdiSend(cfg: NdiSendConfig): void;
  sendNdiFrame(outputId: string, width: number, height: number, data: ArrayBuffer): void;
  // OSC (external control + LiDAR tracking) — receive-first; send is a scaffold.
  configureOsc(cfg: OscConfig): void;
  onOscMessage(cb: (msgs: OscMessage[]) => void): () => void;
  sendOsc(host: string, port: number, address: string, args: (number | string)[]): void;
  listLocalAddrs(): Promise<string[]>;
  // HAP video (native decode, frame-accurate pull → RGBA)
  openHap(path: string): Promise<HapInfo | null>;
  decodeHapFrame(path: string, index: number): Promise<HapFrame | null>;
  closeHap(path: string): void;
  // Projector calibration (native OpenCV addon: structured light + solvePnP)
  calibAvailable(): Promise<boolean>;
  calibDetectBoard(image: ArrayBuffer, w: number, h: number, cols: number, rows: number): Promise<BoardDetectResult | null>;
  /** Detect ArUco fiducials in a camera frame → ids + sub-pixel corners (one-click recalibration). */
  calibDetectAruco(image: ArrayBuffer, w: number, h: number, dict: number): Promise<ArucoDetection | null>;
  calibMapCorners(captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, corners: number[], white: ArrayBuffer, black: ArrayBuffer): Promise<CornerProjMap | null>;
  calibCalibrateProjector(objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number): Promise<ProjectorIntrinsicsResult | null>;
  calibSolvePnp(objectPts: number[], imagePts: number[], k: number[], dist: number[]): Promise<PnpResult | null>;
  /** Open a calibration camera via OpenCV's DirectShow backend (by index) → ok? (for cameras getUserMedia can't drive). */
  calibCameraOpen(index: number, width: number, height: number, fps: number, fourcc: string): Promise<boolean>;
  /** Grab one grayscale frame from the open OpenCV camera (null until a frame is ready / no camera open). */
  calibCameraGrab(): Promise<CameraFrame | null>;
  /** Grab one RGBA frame (data = w*h*4 bytes) from the open OpenCV camera for the colour preview. */
  calibCameraGrabColor(): Promise<CameraFrame | null>;
  /** Release the open OpenCV camera. */
  calibCameraClose(): void;
  /** Set a camera capture property (exposure/gain/gamma/wb/focus/saturation/hue/sharpness/zoom) → applied? */
  calibCameraSetProp(prop: string, value: number): Promise<boolean>;
  /** Read a camera capture property's current value (null if no camera / unknown prop / unsupported). */
  calibCameraGetProp(prop: string): Promise<number | null>;
  /** Dense camera→projector decode for the markerless pipeline (stride subsamples the camera grid). */
  calibDecodeDense(captures: ArrayBuffer, captureCount: number, camW: number, camH: number, projW: number, projH: number, white: ArrayBuffer, black: ArrayBuffer, stride: number): Promise<DenseMap | null>;
  /** RANSAC solvePnP (robust pose); reprojErr is the inlier threshold in projector px. */
  calibSolvePnpRansac(objectPts: number[], imagePts: number[], k: number[], dist: number[], reprojErr: number): Promise<PnpResult | null>;
  /** Guided projector resection (intrinsic guess + degeneracy flags). initK [] → throw-ratio default. */
  calibCalibrateGuided(objectPoints: number[], imagePoints: number[], pointCounts: number[], projW: number, projH: number, initK: number[], fixPrincipalPoint: boolean, fixAspect: boolean): Promise<ProjectorIntrinsicsResult | null>;
  /** Board-free camera intrinsics from the dense camera↔projector correspondences (focal-from-F). */
  calibSelfCalibrate(camX: number[], camY: number[], projX: number[], projY: number[], camW: number, camH: number, projW: number, projH: number): Promise<CameraSelfCal | null>;
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
