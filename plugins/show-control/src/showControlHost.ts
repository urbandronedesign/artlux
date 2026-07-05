// Host-services access for the show-control plugin's UI (settings section + operator panel), stashed
// at renderer activation (Augmenta pattern). The panel is mounted by the host with only `onClose`, so
// it reads live settings + the plugin's own IPC through here. Also exposes the plugin IPC bridge so
// the panel/settings can invoke main (lan-info, regen-pin, devices, set-lock).

import { useSyncExternalStore } from 'react';
import type { RendererHostServices, PluginIpc } from '@artlux/sdk/renderer';
import type { ShowControlSettings } from './types';

// The subset of AppSettings this plugin reads: its own private namespace under plugins['show-control'].
interface HostSettings { plugins?: Record<string, unknown> }

let host: RendererHostServices | null = null;
let ipc: PluginIpc | null = null;

export function setHost(h: RendererHostServices, i: PluginIpc): void { host = h; ipc = i; }
export function getHost(): RendererHostServices | null { return host; }
export function getIpc(): PluginIpc | null { return ipc; }

const EMPTY: ShowControlSettings = {};

// Read the plugin's own settings block reactively (re-renders the section/panel when it changes).
export function useShowControlSettings(): ShowControlSettings {
  return useSyncExternalStore(
    (cb) => host?.settings.subscribe(cb) ?? (() => {}),
    () => {
      const s = (host?.settings.get() as HostSettings) ?? {};
      return (s.plugins?.['show-control'] as ShowControlSettings) ?? EMPTY;
    },
  );
}

// Default config: on, on the plugin's dedicated port.
export const DEFAULTS: Required<ShowControlSettings> = { enabled: true, port: 8788 };
