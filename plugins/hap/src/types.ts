// HAP domain types — moved out of shared/protocol.ts (they cross only the plugin's own IPC channels,
// carried untyped over the generic plugin bridge).

export interface HapInfo {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  codec: string;     // fourcc: Hap1 (DXT1) / Hap5 (DXT5) / HapY (scaled YCoCg) / HapA / HapM
  hasAlpha: boolean;
}

// A decoded HAP frame as raw GPU blocks (uploaded as a compressed texture in the renderer — the GPU
// decompresses, so this is ~8× smaller than RGBA over IPC).
export interface HapFrame {
  width: number;
  height: number;
  format: string;    // "dxt1" | "dxt5" | "ycocg" | "rgtc1" | "bptc"
  data: Uint8Array;  // raw BC/DXT block bytes
}
