// @artlux/sdk/main — main-process (Node) contribution contracts.
//
// Safe to use `node:*` types here. NEVER import `react` / WebGL from this entry: the main bundle
// must not pull renderer-only deps. STATUS: internal + UNSTABLE (see ./index.ts).

import type { OscMessage } from './index.ts';

export type { OscMessage, OscConfig, PluginManifest } from './index.ts';

// ─── Main-process input transport contribution ──────────────────────────────────────────────
// A plugin that ingests external data (e.g. a UDP/OSC LiDAR feed) registers a transport. The
// host owns the IPC wiring: it installs `ipcMain.on(configureChannel)` and, on each decoded
// batch, the transport calls `push(messages)` which the host forwards to the renderer over
// `messageChannel`. Delivery stays array-batched (one IPC message per source packet) so the
// 61fps firehose never stalls the render loop.
export interface MainTransport {
  id: string;
  configureChannel: string; // plugin IPC channel the renderer sends config on (without 'plugin:' prefix)
  messageChannel: string;   // plugin IPC channel the host sends decoded batches on
  start(config: unknown, push: (messages: OscMessage[]) => void): void;
  stop(): void;
}

export interface MainTransportRegistry {
  register(transport: MainTransport): void;
}

// Context handed to a plugin's main-process `activate()`.
export interface MainPluginContext {
  transports: MainTransportRegistry;
}

export interface MainPlugin {
  manifest: import('./index.ts').PluginManifest;
  activate(ctx: MainPluginContext): void;
  deactivate?(): void;
}
