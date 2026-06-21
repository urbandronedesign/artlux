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

export interface ArtNetFramePayload {
  // universe index -> array of DMX channel values (0..255), up to 512 per universe
  universes: Record<number, number[]>;
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
