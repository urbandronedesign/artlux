// Host-services access for the Augmenta plugin's UI (the Augmenta Monitor modal + settings section).
//
// The renderer plugin captures `ctx.host` at activation and stashes it here so the panel — mounted by
// the host's panel registry with no props but `onClose` — can read the live OSC settings (listen
// address / port / enabled) for its status strip. Read-only; the panel never mutates settings.
// Mirrors the LiDAR plugin's trackingHost.

import { useSyncExternalStore } from 'react';
import type { RendererHostServices } from '@artlux/sdk/renderer';

// The subset of AppSettings the Augmenta Monitor reads. (AppSettings is a core type; we only need
// these — Augmenta shares the host's single OSC listener, so the box points at oscListenPort.)
export interface OscSettings {
  oscEnabled?: boolean;
  oscListenPort?: number;
  oscListenAddress?: string;
}

let host: RendererHostServices | null = null;

// Called once from the plugin's renderer activate() (main window — the only place the panel mounts).
export function setHost(h: RendererHostServices): void { host = h; }
export function getHost(): RendererHostServices | null { return host; }

// Reactive host-settings hook: subscribes to the host's settings service so the panel re-renders when
// OSC settings change. Falls back to an empty object before the host is set / in windows without one.
const EMPTY: OscSettings = {};
export function useHostSettings(): OscSettings {
  return useSyncExternalStore(
    (cb) => host?.settings.subscribe(cb) ?? (() => {}),
    () => (host ? (host.settings.get() as OscSettings) : EMPTY),
  );
}
