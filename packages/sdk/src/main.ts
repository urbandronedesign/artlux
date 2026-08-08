// @artlux/sdk/main — main-process (Node) contribution contracts.
//
// Safe to use `node:*` types here. NEVER import `react` / WebGL from this entry: the main bundle
// must not pull renderer-only deps. STATUS: internal + UNSTABLE (see ./index.ts).

export type { OscMessage, OscConfig, PluginManifest, PluginState, PluginStatus } from './index.ts';

// ─── Main-process plugin IPC ────────────────────────────────────────────────────────────────
// The general handle a plugin's main entry uses to talk to its renderer counterpart. The host
// namespaces every channel under 'plugin:<channel>' and binds it to the active window; the plugin
// passes the bare channel. This deliberately supersedes the first cut's OSC-shaped MainTransport
// (push: OscMessage[]) — the NDI plugin needs request/response discovery AND binary frame pushes,
// neither of which the narrow transport contract could express.
export interface MainPluginIpc {
  /** Request/response from the renderer (ipcMain.handle). For discovery, capability checks, etc. */
  handle(channel: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): void;
  /** Fire-and-forget from the renderer (ipcMain.on). For configure/control messages. */
  on(channel: string, handler: (...args: unknown[]) => void): void;
  /** Push to the active window's renderer (webContents.send). For frame/event streams. */
  send(channel: string, ...args: unknown[]): void;
}

// Context handed to a plugin's main-process `activate()`.
export interface MainPluginContext {
  ipc: MainPluginIpc;
  /**
   * The window `ipc.send` targets, or null before one exists / after it is gone.
   *
   * `ipc` covers everything that can be structured-cloned, which is nearly everything — reach for
   * this only when an Electron API needs the window or frame ITSELF. That is the case for handing
   * over a GPU shared texture: `sharedTexture.sendSharedTexture` takes a `WebFrameMain`, and the
   * texture is not clonable, so it cannot travel over `ipc` at all.
   *
   * Typed as `unknown` so the SDK's main entry stays free of an `electron` import in its public
   * surface; callers cast to `BrowserWindow`.
   */
  window(): unknown;
}

export interface MainPlugin {
  manifest: import('./index.ts').PluginManifest;
  activate(ctx: MainPluginContext): void;
  deactivate?(): void;
  /** Optional post-activation self-report (see PluginStatus). Cheap + synchronous; no status = 'ok'. */
  status?(): import('./index.ts').PluginStatus;
}
