// @artlux/sdk/main — main-process (Node) contribution contracts.
//
// Safe to use `node:*` types here. NEVER import `react` / WebGL from this entry: the main bundle
// must not pull renderer-only deps. STATUS: internal + UNSTABLE (see ./index.ts).

export type { OscMessage, OscConfig, PluginManifest } from './index.ts';

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
}

export interface MainPlugin {
  manifest: import('./index.ts').PluginManifest;
  activate(ctx: MainPluginContext): void;
  deactivate?(): void;
}
