// Spout domain types — moved out of shared/protocol.ts (the host no longer needs them; they cross
// only the plugin's own IPC channels, carried untyped over the generic plugin bridge).

export interface SpoutConfig {
  enabled: boolean;
  name?: string; // empty/undefined = active sender
  // How often main should poll the native receiver, in Hz. Carried from the renderer because the rate
  // that matters is AppSettings.engineFps — how often anything CONSUMES a frame — and only the
  // renderer knows it. Absent ⇒ main's own default. See spoutHost.pollFps.
  fps?: number;
  // May main deliver frames as GPU textures instead of pixels? Absent ⇒ yes. The renderer sets it
  // false when the window cannot receive them (no `sharedTextureSupported`) or the operator turned
  // the path off. Saying yes is only a REQUEST: main still falls back per connection if the import
  // fails, which is what a sender on another GPU looks like.
  gpu?: boolean;
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

// The GPU path's frame: a handle instead of pixels. The sender's texture, re-shared by the addon into
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
