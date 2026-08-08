// Spout domain types — moved out of shared/protocol.ts (the host no longer needs them; they cross
// only the plugin's own IPC channels, carried untyped over the generic plugin bridge).

export interface SpoutConfig {
  enabled: boolean;
  name?: string; // empty/undefined = active sender
  // The renderer's engine rate. It only raises the poll FLOOR — the poll follows the SENDER, because
  // sampling below the sender's rate judders and polling above it re-delivers frames. See pollHz.
  fps?: number;
}

// Why Spout is not running. Spout is GPU-only — there is no pixel-readback path behind it — so any
// of these means no picture, and the operator is told rather than silently given a degraded one.
export type SpoutIncompatibility = 'no-native' | 'no-shared-texture' | 'import-failed';

// A frame: a handle instead of pixels. The sender's texture, re-shared by the addon into
// one Electron can import (see native/spout-receiver/src/share.rs for why re-sharing is required).
export interface SpoutShare {
  /** NT share HANDLE, 8 little-endian bytes — Electron's SharedTextureHandle.ntHandle. */
  handle: Uint8Array;
  width: number;
  height: number;
  /** DXGI_FORMAT: 87 = B8G8R8A8_UNORM ('bgra'), 28 = R8G8B8A8_UNORM ('rgba'). */
  format: number;
}

/** What the renderer is told about a GPU frame, since the pixels no longer travel with it. */
export interface SpoutTextureMeta {
  width: number;
  height: number;
}
