// Shared types for the show-control plugin. Platform-neutral (no node:* / no react) so both the
// main and renderer halves import them. The wire protocol between the served tablet PWA and the app
// is JSON over HTTP+SSE (see server.ts); these are the payload shapes.

// ─── Commands the tablet / scheduler send into the show engine ────────────────────────────────
// Each maps 1:1 onto an existing renderer service call in dispatch.ts (parity with oscController).
export type ShowCommand =
  | { kind: 'recallScene'; ref: string }                 // cueBus.requestRecall (scene id or name)
  | { kind: 'fireCue'; ref: string }                     // cueBus.requestFireCue (cue id or name)
  | { kind: 'fireColumn'; bank: string; col: number }    // cueBus.requestFireColumn (0-based col)
  | { kind: 'transport'; action: 'play' | 'pause' | 'stop' | 'seek' | 'loop'; sec?: number; loopOn?: boolean }
  | { kind: 'triggerTransition'; id: string }            // timeline.triggerSmTransition (manual FSM edge)
  | { kind: 'enterState'; id: string }                   // timeline.enterSmState (jump to a state)
  | { kind: 'setFsmEnabled'; on: boolean };              // App state: StateMachine.enabled

// ─── Snapshot: the show model the tablet renders its buttons from ─────────────────────────────
export interface SnapScene { id: string; name: string; accent?: string }
export interface SnapCue { id: string; name: string; row: number; col: number; color?: string }
export interface SnapBank {
  id: string; name: string; rows: number; cols: number;
  cues: SnapCue[]; sceneCells: { col: number; sceneId: string }[];
}
export interface SnapState { id: string; name: string; sceneId?: string }
export interface SnapTransition { id: string; from: string; to: string; manual: boolean }
export interface SnapFsm {
  enabled: boolean;
  initialStateId: string | null;
  states: SnapState[];
  transitions: SnapTransition[];
}
export interface ShowSnapshot {
  scenes: SnapScene[];
  banks: SnapBank[];
  fsm: SnapFsm;
  schedule: ScheduleEntry[];
  projectName: string;
}

// ─── Live status pushed at a throttled rate ───────────────────────────────────────────────────
export interface ShowStatus {
  playing: boolean;
  playhead: number;
  duration: number;
  currentStateId: string | null;
  stateElapsedSec: number;
  activeSceneId: string | null;
  lastFiredTransitionId: string | null; // pulses; the client flashes the edge
  // THE SHOW IS LOADING, NOT STOPPED. On a cold project open (launch, a watchdog relaunch, the
  // playlist's next show) the host holds the state machine until the opening content is decoded. That
  // reads as `playing:false` + `currentStateId:null` — identical to a show an operator stopped — so
  // without this the tablet would say STOPPED through a preload and an operator would press GO over a
  // gate that was about to open by itself. `bootPending` = items still outstanding.
  booting?: boolean;
  bootPending?: number;
  // THE STATE FINISHED AND THE SHOW IS STILL RUNNING. The current state's timeline is holding its last
  // frame (Timeline.holdAtEnd) waiting for a trigger, so the transport reports `playing: true` with a
  // FROZEN playhead — which, on a tablet at the back of a room, is exactly what a hung show looks
  // like. It is the opposite problem to `booting` above and needs the same answer: say which it is.
  held?: boolean;
  ts: number;
}

// ─── In-project schedule (persisted in ProjectData.schedule) ──────────────────────────────────
// Fires a ShowCommand at a wall-clock time on selected weekdays, within the loaded project. Ticked
// renderer-side (this app disables renderer timer throttling), so it runs in broadcast too.
export interface ScheduleEntry {
  id: string;
  enabled: boolean;
  time: string;       // "HH:MM" 24h local
  days: number[];     // 0=Sun … 6=Sat; empty = every day
  action: ShowCommand;
  name?: string;
}

// ─── Machine-global project playlist (userData sidecar; survives relaunch) ────────────────────
// Time-of-day switching of the WHOLE loaded project via relaunch-per-project (robust: clean process
// each switch). Resolved + armed in main; see playlist.ts / scheduler.ts.
export interface PlaylistEntry {
  id: string;
  enabled: boolean;
  projectPath: string; // absolute .artlux file (portable folders resolve to <folder>/project.artlux)
  time: string;        // "HH:MM"
  days: number[];      // 0..6; empty = every day
  name?: string;
}
export interface Playlist {
  enabled: boolean;
  folder?: string;     // last-scanned folder (convenience for the tablet UI)
  entries: PlaylistEntry[];
}
export interface PlaylistStatus {
  currentPath: string | null;  // the project loaded now (from --project=)
  nextPath: string | null;     // the next scheduled project
  nextAt: string | null;       // ISO-ish "HH:MM" of the next switch (informational)
}

// A project discovered by scanning a folder.
export interface ProjectInfo { path: string; name: string; isFolder: boolean }

// ─── Metrics (the Grafana series, delivered natively) ─────────────────────────────────────────
export interface EngineMetrics { fps: number; pps: number; universes: number; up: boolean }
export interface RenderMetrics { fps: number; frameP99: number; workP99: number; longFrames: number }
export interface SystemMetrics {
  cpuPct: number;
  rssMB: number;
  heapMB: number;
  eventLoopLagP50Ms: number;
  eventLoopLagP99Ms: number;
}
// A trimmed watchdog self-heal record (core main owns the full WatchdogEvent; we carry only what the
// tablet audit strip shows). Most-recent-first.
export interface WatchdogEventLite { ts: number; trigger: string; action: string; detail: string; outcome: string }
export interface MetricsSnapshot {
  engine: EngineMetrics | null;
  render: RenderMetrics | null; // renderer frame-time (from perfMonitor via the main window)
  system: SystemMetrics;
  watchdog?: WatchdogEventLite[]; // recent unattended self-heal events (audit surface)
  mode: string;     // editor | broadcast | headless
  version: string;
  ts: number;
}

// ─── Devices + config ─────────────────────────────────────────────────────────────────────────
export interface DeviceInfo { id: string; name: string; pairedAt: number; connected: boolean }
// Plugin-private settings persisted under AppSettings.plugins['show-control'].
export interface ShowControlSettings { enabled?: boolean; port?: number }

// LAN info the settings/panel show so an operator can point a tablet at the app.
export interface LanInfo { urls: string[]; port: number; pin: string; enabled: boolean }

// ─── SSE server → client events ───────────────────────────────────────────────────────────────
export type ServerEvent =
  | { t: 'hello'; locked: boolean; mode: string }
  | { t: 'snapshot'; snapshot: ShowSnapshot }
  | { t: 'status'; status: ShowStatus }
  | { t: 'metrics'; metrics: MetricsSnapshot }
  | { t: 'playlist'; playlist: Playlist; status: PlaylistStatus }
  | { t: 'devices'; devices: DeviceInfo[] }
  | { t: 'locked'; locked: boolean };

// Default UDP-free control port for the PWA (distinct from OSC 10000 / metrics 9464).
export const DEFAULT_PORT = 8788;
