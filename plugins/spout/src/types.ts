// Spout domain types — moved out of shared/protocol.ts (the host no longer needs them; they cross
// only the plugin's own IPC channels, carried untyped over the generic plugin bridge).

export interface SpoutConfig {
  enabled: boolean;
  name?: string; // empty/undefined = active sender
}

// Spout receive (Windows GPU texture share). `data` is RGBA downscaled to width×height; src* is the
// sender's true resolution (for stage aspect).
export interface SpoutFrame {
  width: number;
  height: number;
  data: Uint8Array;
  srcWidth: number;
  srcHeight: number;
}
