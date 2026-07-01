// NDI domain types — moved out of shared/protocol.ts (host no longer needs them; they cross only
// the plugin's own IPC channels, carried untyped over the generic plugin bridge).

export interface NdiConfig {
  enabled: boolean;
  name?: string; // empty/undefined = first discovered source
}

// NDI receive (network video). `data` is RGBA downscaled to width×height; src* is the source's
// true resolution (for stage aspect).
export interface NdiFrame {
  width: number;
  height: number;
  data: Uint8Array;
  srcWidth: number;
  srcHeight: number;
}

export interface NdiSendConfig {
  outputId: string;
  enabled: boolean;
  name?: string;
}
