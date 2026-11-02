// Syphon domain types. These cross only the plugin's own IPC channels, carried untyped over the
// generic plugin bridge, so they stay here rather than in shared/protocol.ts.

/** A server as the picker sees it. **Identity is the pair** — see `label` and docs/SYPHON.md. */
export interface SyphonServerDesc {
  name: string;
  appName: string;
  /** `App — Name`, or the app alone when unnamed. Computed natively so the picker and the logs agree
   *  on one spelling instead of each inventing their own. */
  label: string;
}

export interface SyphonConfig {
  enabled: boolean;
  /** Both empty = active server (whatever is running). Matching on the name alone is not enough:
   *  Syphon server names are frequently blank and non-unique. */
  name?: string;
  appName?: string;
  /** The renderer's engine rate. It only raises the poll FLOOR — the poll follows the SERVER,
   *  because sampling below the server's rate judders. See pollHz in syphonManager. */
  fps?: number;
}

// Why Syphon is not running. Syphon is GPU-only — there is no pixel-readback path behind it — so any
// of these means no picture, and the operator is told rather than silently given a degraded one.
export type SyphonIncompatibility = 'no-native' | 'no-shared-texture' | 'import-failed';

/** A frame: an `IOSurfaceRef` instead of pixels.
 *
 *  ⚠ +1 RETAINED. Unlike Windows, where Electron duplicates the NT handle, Electron on darwin
 *  RETAINS the IOSurface on import rather than taking ownership — so this reference is still ours
 *  after the hand-off and must go back via `releaseSurface`. */
export interface SyphonShare {
  /** The `IOSurfaceRef` as 8 little-endian bytes — Electron's `SharedTextureHandle.ioSurface`. */
  surface: Uint8Array;
  width: number;
  height: number;
}

/** What the renderer is told about a GPU frame, since the pixels no longer travel with it. */
export interface SyphonTextureMeta {
  width: number;
  height: number;
}
