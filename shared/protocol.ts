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
  /**
   * Renderer → main (invoke): the DMX fixture-library CATALOGUE — one small row per profile, enough
   * to search and to render a picker. Loaded once at startup.
   */
  FIXTURE_LIBRARY_INDEX: 'fixtureLibrary:index',
  /**
   * Renderer → main (invoke): the FULL profiles for one manufacturer key, fetched lazily when the
   * operator actually patches one. The whole library is ~4 MB of JSON and deliberately does NOT go
   * into the renderer bundle.
   */
  FIXTURE_LIBRARY_GET: 'fixtureLibrary:get',
  /**
   * Renderer → main (invoke): USB serial devices that could be a DMX interface, for the Outputs
   * picker. Re-queried on demand (Rescan), because a widget is routinely plugged in after launch.
   */
  SERIAL_DEVICES: 'dmx:serial-devices',
  /**
   * Renderer → main (invoke): pick a .gdtf and import it as a user fixture profile (channels, modes
   * AND the real geometry). Returns the profile id plus any notes, or null if cancelled.
   */
  FIXTURE_IMPORT_GDTF: 'fixtureLibrary:import-gdtf',
  /** Renderer → main (invoke): write a recorded LiDAR-blob take to a sidecar file → absolute path. */
  SAVE_TRACKING_TAKE: 'tracking:save-take',
  /** Renderer → main (invoke): pick + copy media into the project's assets/<cat>/ → AssetEntry[]. */
  IMPORT_ASSETS: 'asset:import',
  /** Renderer → main (invoke): copy one already-known file into assets/<cat>/ → AssetEntry (e.g. a recorded take). */
  IMPORT_ASSET_FILE: 'asset:import-file',
  /** Renderer → main (invoke): walk the project's assets/ for media the library doesn't have → AssetEntry[]. */
  SCAN_ASSETS: 'asset:scan',
  /** Renderer → main: reveal a file in the OS file manager. */
  SHOW_ITEM_IN_FOLDER: 'asset:show-in-folder',
  /** Renderer → main (invoke): which of these paths exist on disk → boolean[]. */
  ASSET_EXISTS: 'asset:exists',
  /** Renderer → main (invoke): pick a video file → absolute path. */
  PICK_VIDEO: 'app:pick-video',
  /** Renderer → main (invoke): pick/create a project folder → { root, projectFile }. */
  PROJECT_NEW_FOLDER: 'project:new-folder',
  /** Renderer -> main: lay out an ALREADY-CHOSEN folder as a project (assets/ tree). No dialog. */
  PROJECT_PREPARE_FOLDER: 'project:prepare-folder',
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
  /**
   * Main → renderer: hand off a MessagePort for OUTPUT FRAMES.
   *
   * The renderer relays this port straight into the frame-engine worker, so packed universes travel
   * worker → main without waking the main thread at all. `IPC.FRAME` remains for the main-thread
   * engine and is byte-identical (both carry shared/frameCodec's encodeFrame output) — the port is a
   * second road to the same door, not a second protocol.
   */
  ENGINE_PORT: 'engine:port',
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
  /** Main → splash window: the whole boot report, re-sent on every change (see BootReport). */
  SPLASH_REPORT: 'splash:report',
  /** Splash window → main: mounted and listening — send the report now (it may already be complete). */
  SPLASH_READY: 'splash:ready',
  /** Splash window → main: close me (the user clicked or pressed Esc). */
  SPLASH_DISMISS: 'splash:dismiss',
  /** Main → splash window: run your exit fade — you are about to be destroyed. */
  SPLASH_FADE_OUT: 'splash:fade-out',
  /** Editor renderer → main: this window's plugin activation results, for the splash's console. */
  SPLASH_RENDERER_REPORT: 'splash:renderer-report',
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

// ─── The boot report (what the startup splash's console shows) ───────────────────────────────
// One row per thing that had to load: the host's own native addons, then each plugin half. The
// states mirror @artlux/sdk's PluginState — duplicated here rather than imported because the
// preload and the splash window must not depend on the SDK, and this is the IPC contract.
//
// This exists because every native-backed feature graceful-degrades: a missing .node disables the
// feature, logs one line, and the app boots looking perfectly healthy. On a load-in nobody is
// reading a terminal, so "why is there no NDI" cost real time to answer. Now it is on screen at
// startup, and it is the truth — each row is written when that thing's load actually returned.
export type BootState = 'ok' | 'degraded' | 'off' | 'error';

export interface BootEntry {
  /** Which layer this loaded in. 'native' = host-owned addon; the rest are plugin halves. */
  group: 'native' | 'main' | 'renderer';
  id: string;         // 'ndi', 'output-engine', … (a plugin's two halves share one id)
  name?: string;      // human label; falls back to id
  detail?: string;    // one short phrase: 'native addon unavailable', 'video codec registered'
  state: BootState;
  ms?: number;        // how long it took to load/activate; absent when it never ran
}

export interface BootReport {
  entries: BootEntry[];
  /** Host natives + main-process plugins have all reported. */
  mainDone: boolean;
  /** The editor renderer has reported its plugin halves (the second and last wave). */
  rendererDone: boolean;
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

// One capture mode a camera REALLY advertises, read from DirectShow's IAMStreamConfig by the calib
// addon (`cameraListModes`). OpenCV's videoio can only be *told* a resolution — a mode the device
// refuses is applied silently, so a picker built from a hardcoded list lets you choose 1920×1080 on a
// camera whose only mode is 640×480 and shows no sign that nothing changed.
export interface CameraMode {
  width: number;
  height: number;
  fps: number;        // the mode's default rate
  minFps: number;     // drivers advertise a RANGE per resolution, not a single rate
  maxFps: number;
  fourcc: string;     // 'MJPG' | 'YUY2' | 'RGB ' | …
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
  // ---- UI cost (services/uiPerfMonitor) — why a frame was late, not just that it was ----
  // The fields above say a frame landed late; these say whether the MAIN THREAD was blocked while it
  // did. All optional and additive: an older renderer simply omits them and every consumer (metrics,
  // watchdog, the SDK's onRenderStats) is unchanged. Long tasks are always measured; the commit
  // figures only report while the opt-in React profiler is on (`?uiperf=1`).
  longTasks?: number;      // main-thread tasks >50 ms in the last second
  longTaskMs?: number;     // ms — total time they blocked the thread
  longTaskMaxMs?: number;  // ms — the worst single one
  commits?: number;        // React commits in the last second (0 unless profiling)
  commitMs?: number;       // ms — their summed actualDuration
}

// 'enttec' is a USB-serial DMX interface rather than a network protocol: it carries a COM PORT in
// the `ip` field (the wire format needed no new slot) and drives exactly one universe.
export type OutputProtocol = 'artnet' | 'sacn' | 'enttec';

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

// A TRIGGER ZONE on a tracking surface — an area of the real venue that the show can react to.
// (@artlux/plugin-lidar-tracking owns the behaviour; only the persisted shape is core, exactly like
// `SourceType.TRACKING` and the trackingSmoothing/trackingMergeRadius settings below.)
//
// NORMALIZED, NOT METRES, and that is the load-bearing decision: blobs arrive as `u`/`v` in [0..1] on
// a named surface, so a normalized rect is what the test actually compares against — no unit
// conversion in the hot path, and no re-authoring when the venue re-measures itself. The tracker
// publishes its scale live (`specs/Scalex|Scaley`), so metres are a DISPLAY concern, derivable at any
// time; the reverse is not true, because a stored metre value silently means something else the day
// the zone is rescaled.
//
// ⚠ ORIGIN IS BOTTOM-LEFT, Y UP — the blob protocol's own convention (trackingStore), NOT screen
// space. `v0` is the LOW edge. Anything drawing this in a top-left DOM box must flip (screenUV).
export interface TrackingZone {
  id: string;
  name: string;                  // readable — it is what the trigger UI lists and what an operator debugs by
  surface: string;               // SOL | MUR | SOL_MUR — a trackingStore surface key
  u0: number; v0: number;        // rect corners, normalized [0..1]; stored min→max (u0<u1, v0<v1)
  u1: number; v1: number;
  color?: string;
  // OCCUPANCY, with hysteresis — the difference between a trigger and a tripwire that fires forever.
  minBlobs?: number;             // people needed before the zone counts as occupied (default 1, AFTER people-merge)
  enterSec?: number;             // must stay occupied this long before it latches (debounce, default 0.2)
  exitSec?: number;              // must stay empty this long before it un-latches (hysteresis, default 0.5)
}

export interface Scene3D {
  models: SceneModel[];
  lightIntensity: number;             // per-fixture venue light gain
  environment: boolean;               // ambient/HDR base lighting
  exposure: number;                   // tone-mapping exposure
  gridVisible: boolean;
  // ATMOSPHERE — how much haze the room has, 0..1 (absent ⇒ a modest default).
  //
  // A beam is only visible because of what is in the air; with no haze a real venue shows a pool of
  // light and no beam at all. This scales the volumetric cones' opacity, so the 3D view can be made
  // to match what the room will actually look like on the night rather than always showing the
  // hazed-up version.
  hazeDensity?: number;
  reflectiveFloor?: boolean;          // mirror floor reflecting the LEDs/meshes
  trackingViz?: boolean;              // overlay the LiDAR SOL/MUR zones + live blob markers
  trackingSmoothing?: number;         // 0 = raw, 1 = heavy (One-Euro min-cutoff)
  trackingPredictMs?: number;         // blob prediction horizon, ms (0 = off)
  trackingLabels?: boolean;           // show each blob's tracking id
  trackingMergePeople?: boolean;      // merge nearby blobs into one "person" (venue emits 2 blobs/person)
  trackingMergeRadius?: number;       // merge radius in metres (blobs within this distance = same person)
  // VENUE-WIDE ZONE DWELL — the on-site tuning knob for every trigger zone at once. A zone's occupancy
  // latches once presence has lasted `enter` seconds and clears once absence has lasted `exit` seconds;
  // the right values depend on how hard the real tracker flickers, which is a property of the ROOM, not
  // of any one zone — so they live here, in the tracking parameters, next to the merge radius, rather
  // than being retyped into every zone. A zone MAY still override them (TrackingZone.enterSec/exitSec);
  // absent there ⇒ it follows these. Absent here ⇒ 0.2 / 0.5 (the shipped defaults, tuned to the
  // recording — see docs/TRACKING_SYNC.md).
  trackingZoneEnterSec?: number;
  trackingZoneExitSec?: number;
  // THE ROOM. Project scope — deliberately STRIPPED from a scene's look snapshot (App.buildSceneSnapshot),
  // because a zone is a rectangle on a real floor and does not change shape when the lighting does.
  trackingZones?: TrackingZone[];     // named trigger areas the show machine can react to (see TrackingZone)
  // …AND THE LOOK'S SUBSCRIPTION TO IT. Which of the room's zones this scene actually listens to. Unlike
  // `trackingZones` above, this one DOES travel in the snapshot: "the welcome state watches the entrance;
  // the performance state watches the stage" is part of what a look IS.
  //
  // ABSENT ⇒ EVERY ZONE IS LIVE, and that default is load-bearing: every project and every scene captured
  // before this field existed must keep behaving exactly as it did. An empty ARRAY is different and means
  // what it says — this look listens to nothing.
  activeZoneIds?: string[];
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
  trackingZoneEnterSec: 0.2,
  trackingZoneExitSec: 0.5,
  trackingZones: [],
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

// ── DMX fixture profiles (a "personality") ──────────────────────────────────────────────────────
//
// A renderer `Fixture` describes a PIXEL fixture: `ledCount` cells of RGB/W, occupying
// `ledCount × channelsPerPixel` channels. That is LED tape and panels, and it cannot express a
// moving head — named Pan/Tilt/Gobo/Shutter channels, 16-bit pairs, discrete gobo slots, and
// several MODES of the same physical light.
//
// These types live in shared/ (re-exported from renderer/types.ts) because all three of the
// renderer, MAIN (which reads the bundled library off disk) and the project file need them.
//
// A profile is that missing description. It is NOT a `FixtureTemplate` (which is a saved pixel
// LAYOUT): a template says "16 LEDs, GRB, serpentine", a profile says "channel 9 is Pan, 0..540°,
// 16-bit with its fine byte at channel 10".
//
// WHY OUR OWN FORMAT and not the source's. The generated library is converted from the Open
// Fixture Library, whose own docs state its JSON is "not intended to be used directly by other
// software" and may break between releases. We convert ONCE, at build time (scripts/build-fixture-
// library.mjs), into the shape the packer actually wants — see `ProfileMode.slots`.
export type ChannelRole =
  // Intensity + colour mixing. The emitter list is exactly the one the source library actually
  // uses, measured rather than guessed — and `warmWhite`/`coldWhite` are their OWN roles, not
  // aliases of `white`: a CCT-mixing fixture has separate warm and cold emitters, and folding both
  // onto one role would drive them together and make the fixture unable to reach either extreme.
  | 'dimmer' | 'red' | 'green' | 'blue' | 'white' | 'warmWhite' | 'coldWhite'
  | 'amber' | 'uv' | 'lime' | 'indigo' | 'cyan' | 'magenta' | 'yellow' | 'colorTemp'
  // movement + optics
  | 'pan' | 'tilt' | 'panTiltSpeed' | 'zoom' | 'focus' | 'iris' | 'frost'
  // beam shaping + effects
  | 'shutter' | 'strobe' | 'colorWheel' | 'goboWheel' | 'goboRotation'
  | 'prism' | 'prismRotation' | 'speed' | 'maintenance' | 'macro'
  // Atmospherics. A hazer is not a light, but it is patched on the same wire and the 3D scene's
  // beam density is only believable when it tracks the haze that is actually in the room.
  | 'fog'
  // A channel we could not map semantically. STILL ADDRESSABLE AND CONTROLLABLE — it just gets no
  // role-aware treatment (no colour mixing, no 3D aim, not matched when a take is retargeted).
  // Unknown must never mean "dropped": an unmapped channel still occupies a DMX slot, and a
  // fixture whose footprint shrank because we didn't recognise channel 12 is mis-patched.
  | 'unknown';

// One discrete band within a channel — a gobo, a colour-wheel slot, a strobe mode.
export interface ProfileRange {
  from: number;        // inclusive DMX byte 0..255
  to: number;          // inclusive
  label: string;
  color?: string;      // colour-wheel slot, hex — drives the 3D beam tint
  goboKey?: string;    // gobo image key → resources/fixture-library/gobos/<key>.png
}

export interface ProfileChannel {
  key: string;              // stable slot key WITHIN this profile — 'pan', 'gobo1'
  label: string;            // 'Pan', 'Gobo Wheel'
  role: ChannelRole;
  resolution: 1 | 2 | 3;    // bytes; a source format's "fine" channels are folded in here
  default: number;          // 0..1 normalised — what the fixture holds before anything drives it
  highlight?: number;       // 0..1 value for a "highlight this fixture" command
  invert?: boolean;
  // PHYSICAL range, in `unit`. Pan/tilt are stored in DEGREES on purpose: it is what lets a
  // recorded movement replay correctly on a head with a different total sweep (a 540° take on a
  // 630° head), and it is what the 3D scene needs to aim a beam at a point in the room. Consoles
  // call the same idea "head morphing"; it only works because the value is not a raw DMX byte.
  min?: number; max?: number; unit?: string;
  ranges?: ProfileRange[];  // present ⇒ this is a discrete channel (author picks a slot, not a %)
  geometry?: string;        // GDTF geometry node this channel drives (pan → yoke, tilt → head)
}

// A GDTF-imported mesh + its articulation. Absent ⇒ the renderer draws a procedural archetype
// sized from `physical.dimsMm`. Absent is the NORMAL case: the bundled library carries no meshes,
// and a GDTF is imported only for the handful of fixture types actually in the rig.
//
// ⚠ A GDTF DOES NOT SHIP ONE MESH. Each geometry node references its OWN model file (Body.glb,
// Yoke.glb, …) and the tree says how they hinge — which is the whole point: a single baked mesh
// could not articulate. The renderer composes them.
export interface ProfileGeometry {
  /** Directory the extracted meshes were cached into. */
  modelPath: string;
  nodes: ProfileGeoNode[];
}
export interface ProfileGeoNode {
  name: string;
  parent?: string;                   // absent ⇒ root
  kind: 'normal' | 'axis' | 'beam';
  // GDTF declares an <Axis> geometry for each moving part but does NOT say which is pan and which
  // is tilt — that is determined by which DMX channel targets the geometry. Resolved at import.
  axis?: 'pan' | 'tilt';
  /** Offset from the PARENT node, in metres, already converted from GDTF's Z-up to Y-up. */
  offset?: { x: number; y: number; z: number };
  /** The GDTF Model this node uses (a name, not a file). */
  model?: string;
  /** Absolute path to this node's extracted .glb, when it had one. */
  modelPath?: string;
}

// One MODE (a "personality") of a fixture: the same light, a different channel count and order.
export interface ProfileMode {
  key: string;
  name: string;              // '16-Bit Extended'
  footprint: number;         // DMX channels this mode consumes
  // THE PACKER'S VIEW, and the reason this is an array and not a map: index = offset from the
  // fixture's startAddress, so emitting a frame is a straight loop with no lookup and no ordering
  // decision at runtime. `null` is a channel the manufacturer reserves but does not use — it still
  // OCCUPIES its slot (that is why footprint counts it) and is written as 0.
  //
  // INVARIANT: slots.length === footprint. The build script enforces it and drops any profile that
  // violates it, because a mode whose slot array is shorter than its footprint mis-addresses every
  // fixture patched after it.
  slots: Array<{ channelKey: string; byte: 0 | 1 | 2 } | null>;
}

export interface FixtureProfile {
  id: string;                 // '<manufacturerKey>/<fixtureKey>', e.g. 'martin/mac-250-krypton'
  manufacturer: string;
  model: string;
  // Alternate spellings the "add fixture by reference" search matches on — short codes ('MAC250'),
  // the source's own short name, and a punctuation-stripped normal form. Without these, typing a
  // real-world part code finds nothing and the library reads as if it lacked the fixture.
  aliases?: string[];
  categories?: string[];      // 'Moving Head' | 'Color Changer' | … — picks the 3D archetype
  channels: ProfileChannel[];
  modes: ProfileMode[];
  physical?: {
    weightKg?: number;
    dimsMm?: [number, number, number];
    powerW?: number;
    lensDegMin?: number; lensDegMax?: number;   // beam cone half-angle range
  };
  geometry?: ProfileGeometry;
  source: {
    origin: 'ofl' | 'gdtf' | 'pdf' | 'manual';
    ref?: string;             // upstream fixture key / file / URL
    rev?: string;             // upstream revision or commit
    importedAt: string;       // ISO date
  };
  // FALSE = a DRAFT whose channel table nobody has checked against the manufacturer's manual
  // (PDF-extracted, or hand-authored in a hurry). A draft is deliberately still USABLE — you may
  // need one at 2am in a venue — but it must never be silently trusted, so every surface that
  // shows a profile shows this too. Only a human review sets it true.
  verified: boolean;
}

// One row of the library CATALOGUE — what the picker and the "add by reference" search read. Small
// enough that all ~500 rows load at startup; the full channel tables are fetched per manufacturer
// only when a fixture is actually patched.
export interface FixtureProfileSummary {
  id: string;
  manufacturer: string;
  model: string;
  aliases?: string[];
  categories?: string[];
  modes: Array<{ key: string; name: string; footprint: number }>;
  /** Absent on bundled rows (all verified); false on a user draft awaiting review. */
  verified?: boolean;
  /** Where this row came from, so the UI can badge a user draft distinctly from the shipped set. */
  origin?: FixtureProfile['source']['origin'];
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
  // THE DMX FIXTURE PROFILES THIS SHOW USES, embedded on save.
  //
  // A profile is normally resolved out of the app's bundled library, so embedding looks redundant —
  // it is not. A project is portable (docs/ASSETS.md): the operator copies the folder to the venue
  // PC. If that machine's library is older, or the fixture came from a hand-authored/PDF-derived
  // profile in THAT operator's userData, the profile is simply absent, and a fixture with an
  // unresolved profile has NO KNOWN FOOTPRINT — so the patch silently shifts for every fixture after
  // it on the same controller. Carrying the profiles with the show removes the failure entirely.
  //
  // Only the profiles actually referenced by a fixture are written, so this stays small.
  // Resolution order on load: THIS → userData/fixture-profiles → bundled library.
  fixtureProfiles?: FixtureProfile[];
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
  /** Show the startup splash (credits + licence + the plugin/native boot console). Default: true.
      Editor mode only — headless/broadcast never open it regardless (see main/splashWindow.ts). */
  showSplash?: boolean;
  /** User keyboard-shortcut overrides, keyed by stable shortcut id → its bound chords (e.g. ["Ctrl+Z"]).
      Renderer-owned blob (the full registry of default bindings lives in the renderer, this stores only
      the deltas the user changed). Absent / missing keys = the registry default. */
  shortcuts?: Record<string, string[]>;
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
// menus in this app are static by construction. Core's nine are the ones worth a menu entry.
//
// The accelerator labels are POSITIONAL (the rail derives Ctrl+N from its own index), so this array's
// order must match the rail's cluster/order sort or the labels lie. `verify:invariants` checks that
// every id here still resolves to a registered context, because a dead entry is otherwise silent: the
// menu item renders and `goToContext` no-ops.
export interface ContextMenuEntry { id: string; label: string; accel?: string; sepBefore?: boolean }
export const CONTEXT_MENU_ITEMS: ContextMenuEntry[] = [
  { id: 'mapping',  label: 'Mapping',            accel: 'Ctrl+1' },
  { id: '3d',       label: 'Venue & Rig',        accel: 'Ctrl+2' },
  { id: 'project',  label: 'Projection Outputs', accel: 'Ctrl+3', sepBefore: true },
  { id: 'calib',    label: 'Calibration',        accel: 'Ctrl+4' },
  { id: 'scenes',   label: 'Scenes & Cues',      accel: 'Ctrl+5', sepBefore: true },
  { id: 'machine',  label: 'Show Machine',       accel: 'Ctrl+6' },
  { id: 'audio',    label: 'Audio',              accel: 'Ctrl+7' },
  { id: 'show',     label: 'Show / Perform',     accel: 'Ctrl+8' },
  // App-level, hence the rule above it — same split the rail draws. Also reachable as Ctrl+, from the
  // File menu; both land on the same context, so there is one place Preferences lives, not two.
  { id: 'settings', label: 'Preferences',        accel: 'Ctrl+9', sepBefore: true },
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
  /** Prepare a folder the caller already picked (the launcher's --new-project= path). */
  prepareProjectFolder(root: string): Promise<NewProjectFolder>;
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
  // Startup splash (its own window; see main/splashWindow.ts). The editor renderer uses only
  // reportBootStatus — the other three are the splash window's own side of the conversation.
  /** Editor renderer → main: this window's plugin activation results (the splash's second wave). */
  reportBootStatus(entries: BootEntry[]): void;
  /** Splash → main: mounted; send the report. */
  splashReady(): void;
  /** Main → splash: the full report, re-sent on every change (idempotent — render it as-is). */
  onBootReport(cb: (r: BootReport) => void): () => void;
  /** Splash → main: close the splash window now. */
  splashDismiss(): void;
  /** Main → splash: run the exit fade; the window is destroyed a beat later regardless. */
  onSplashFadeOut(cb: () => void): () => void;
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
  // DMX fixture library (bundled generated set + the operator's own profiles in userData).
  /** The whole catalogue, bundled + user, user rows winning on id. Cached in main. */
  fixtureLibraryIndex(): Promise<FixtureProfileSummary[]>;
  /**
   * Full profiles for one manufacturer key (the `<manufacturer>` half of a profile id), plus any
   * user profiles for that manufacturer. Returns [] for an unknown key rather than throwing.
   */
  fixtureLibraryGet(manufacturerKey: string): Promise<FixtureProfile[]>;
  /** USB serial devices that could be a DMX interface (ENTTEC DMX USB Pro and compatibles). */
  listSerialDevices(): Promise<Array<{ path: string; label: string }>>;
  /** Pick and import a .gdtf → a user profile carrying the manufacturer's own channels and meshes. */
  importGdtf(): Promise<{ id: string; model: string; notes: string[] } | null>;
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
  /**
   * Walk the project's assets/ tree and return entries for media files the library doesn't have yet
   * (files copied in by hand, outside Import). `knownPaths` is every path the library holds today.
   * Copies nothing and modifies nothing on disk — the caller appends what it gets back.
   */
  scanAssets(projectFile: string, knownPaths: string[]): Promise<AssetEntry[]>;
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
