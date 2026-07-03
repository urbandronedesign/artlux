// Host-services access for the MediaPipe plugin.
//
// The renderer plugin captures `ctx.host` at activation and stashes it here so non-React modules
// (poseEngine reading camera/model settings) and the debug panel + settings section can reach the host
// settings/scene services. Mirrors the LiDAR plugin's trackingHost. Read-only for settings reads;
// settings edits go through the SettingsSection's onChange, scene edits are not used here.

import { useSyncExternalStore } from 'react';
import type { RendererHostServices } from '@artlux/sdk/renderer';

let host: RendererHostServices | null = null;

// Called once from the plugin's renderer activate().
export function setHost(h: RendererHostServices): void { host = h; }
export function getHost(): RendererHostServices | null { return host; }

// Reactive host-settings hook for the settings section + debug panel. Falls back to an empty object
// before the host is set / in windows without one.
const EMPTY = {} as Record<string, unknown>;
export function useHostSettings<T = Record<string, unknown>>(): T {
  return useSyncExternalStore(
    (cb) => host?.settings.subscribe(cb) ?? (() => {}),
    () => (host ? (host.settings.get() as T) : (EMPTY as T)),
  );
}
