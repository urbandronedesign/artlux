// Shared IPC contract between the Electron main process and the renderer.
// Imported by both sides so channel names and payload shapes stay in sync.

export const IPC = {
  /** Renderer → main: set/refresh the UDP output target. */
  CONFIGURE: 'dmx:configure',
  /** Renderer → main: ship one frame of universe data to transmit. */
  FRAME: 'dmx:frame',
  /** Main → renderer: output connection/health status. */
  STATUS: 'dmx:status',
} as const;

export interface OutputConfig {
  ip: string;
  port: number;
  broadcast: boolean;
}

// One routing destination: a controller and the universes destined for it.
export interface UniverseTarget {
  ip: string;
  port: number;
  broadcast: boolean;
  sparse: boolean; // skip universes unchanged since last send
  universes: Record<number, number[]>;
}

export interface ArtNetFramePayload {
  targets: UniverseTarget[];
}

/** API surface exposed on `window.artlux` by the preload via contextBridge. */
export interface ArtluxApi {
  configureOutput(cfg: OutputConfig): void;
  sendArtNet(payload: ArtNetFramePayload): void;
  onStatus(cb: (connected: boolean) => void): () => void;
}

declare global {
  interface Window {
    artlux?: ArtluxApi;
  }
}
