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
  /** Main → renderer: a native-menu command (save/open/undo/about/…). */
  MENU_ACTION: 'menu:action',
  /** Renderer → main (invoke): app name + version (for About). */
  APP_INFO: 'app:get-info',
  /** Renderer → main: open a URL in the default browser. */
  OPEN_EXTERNAL: 'app:open-external',
  /** Renderer → main: check GitHub for a newer release. */
  UPDATE_CHECK: 'update:check',
  /** Renderer → main: user accepted — download the available update. */
  UPDATE_DOWNLOAD: 'update:download',
  /** Renderer → main: user accepted — quit and install the downloaded update. */
  UPDATE_INSTALL: 'update:install',
  /** Main → renderer: auto-update lifecycle events. */
  UPDATE_EVENT: 'update:event',
  /** Renderer → main: open (or focus) the dedicated 3D Scene window. */
  SCENE_OPEN: 'scene:open',
  /** Main → renderer: hand off a MessagePort that bridges main ↔ scene windows. */
  SCENE_PORT: 'scene:port',
  /** Renderer → main (invoke): pick a GLB/glTF venue model → absolute path. */
  SCENE_PICK_MODEL: 'scene:pick-model',
  /** Renderer → main (invoke): read a model file's bytes by path. */
  SCENE_READ_MODEL: 'scene:read-model',
  /** Renderer → main (invoke): read any file's bytes by path (e.g. timeline MP4s). */
  READ_FILE: 'app:read-file',
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

// One Surface routed to a physical projector as its own fullscreen output.
export interface ProjectorOutput {
  surfaceId: string;
  enabled: boolean;
  displayId: number | null;   // Electron display.id (session-stable)
  displayLabel?: string;      // fallback re-match across replug/reboot
  cornerPin: CornerPin;       // warp of the surface content onto the projection
}

export const defaultProjectorOutput = (surfaceId: string): ProjectorOutput => ({
  surfaceId, enabled: false, displayId: null, cornerPin: defaultCornerPin(),
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
  scale: number;                      // uniform (1 = GLB units are meters)
  visible: boolean;
}

// 3D Scene config (venue meshes + lighting), persisted per project.
export interface Scene3D {
  models: SceneModel[];
  lightIntensity: number;             // per-fixture venue light gain
  environment: boolean;               // ambient/HDR base lighting
  exposure: number;                   // tone-mapping exposure
  gridVisible: boolean;
  reflectiveFloor?: boolean;          // mirror floor reflecting the LEDs/meshes
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
});

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
  scene3D?: Scene3D;
  timeline?: unknown; // Timeline (renderer type) — video-layer NLE
  projectorOutputs?: ProjectorOutput[]; // per-surface fullscreen projector mappings
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
  // App chrome
  onMenuAction(cb: (action: string) => void): () => void;
  getAppInfo(): Promise<AppInfo>;
  openExternal(url: string): void;
  // Auto-update (user-gated: nothing downloads or installs without an explicit call)
  checkForUpdates(): void;
  downloadUpdate(): void;
  installUpdate(): void;
  onUpdate(cb: (e: UpdateEvent) => void): () => void;
  // 3D Scene window. The bridge MessagePort arrives via a window 'artlux:scene-port'
  // message (forwarded by the preload), not through this API — see App/SceneApp.
  openSceneWindow(): void;
  pickModel(): Promise<string | null>;
  readModel(path: string): Promise<Uint8Array | null>;
  // Generic file access (timeline video clips)
  readFile(path: string): Promise<Uint8Array | null>;
  pickVideo(): Promise<string | null>;
  /** Resolve a dropped File to its absolute path (Electron webUtils). */
  getPathForFile(file: File): string;
  // Projector outputs (per-surface fullscreen on a physical display). The bridge
  // MessagePort arrives via a window 'artlux:projector-port' message (preload), not here.
  listDisplays(): Promise<DisplayInfo[]>;
  openProjector(surfaceId: string, displayId: number): void;
  closeProjector(surfaceId: string): void;
  setProjectorDisplay(surfaceId: string, displayId: number): void;
  onDisplaysChanged(cb: (displays: DisplayInfo[]) => void): () => void;
}

declare global {
  interface Window {
    artlux?: ArtluxApi;
  }
}
