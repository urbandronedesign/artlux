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
} as const;

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

/** API surface exposed on `window.artlux` by the preload via contextBridge. */
export interface ArtluxApi {
  configureOutput(cfg: OutputConfig): void;
  /** One frame, encoded by shared/frameCodec.encodeFrame (binary handoff). */
  sendArtNet(frame: ArrayBuffer): void;
  onStatus(cb: (connected: boolean) => void): () => void;
  onDmxStats(cb: (stats: OutputStats) => void): () => void;
  configureInput(cfg: InputConfig): void;
  onDmxInput(cb: (frames: InputFrame[]) => void): () => void;
}

declare global {
  interface Window {
    artlux?: ArtluxApi;
  }
}
