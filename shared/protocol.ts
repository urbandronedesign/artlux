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
} as const;

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
  data: Uint8Array; // RGBA
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

// ---- Persistence (project / rig / preferences) -------------------------------

// Full project file (kept loose here so shared/ stays decoupled from renderer types).
export interface ProjectData {
  version: string;
  timestamp?: string;
  fixtures: unknown[];
  settings: unknown;
  globalBrightness: number;
  groups: unknown[];
  scenes: unknown[];
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
}

declare global {
  interface Window {
    artlux?: ArtluxApi;
  }
}
