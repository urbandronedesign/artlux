// Host-services access for the LiDAR plugin's UI (the OSC Monitor modal panel).
//
// The renderer plugin captures `ctx.host` at activation and stashes it here so the panel — mounted by
// the host's panel registry with no props but `onClose` — can read the live OSC settings (listen
// address / port / enabled) for its status strip. Read-only; the panel never mutates settings.

import { useSyncExternalStore } from 'react';
import type { RendererHostServices } from '@artlux/sdk/renderer';
import type { Scene3D, TrackingZone } from '../../../shared/protocol';

// The subset of AppSettings the OSC Monitor reads. (AppSettings is a core type; we only need these.)
export interface OscSettings {
  oscEnabled?: boolean;
  oscListenPort?: number;
  oscListenAddress?: string;
}

let host: RendererHostServices | null = null;

// Called once from the plugin's renderer activate() (main window — the only place the panel mounts).
export function setHost(h: RendererHostServices): void { host = h; }

// Reactive host-settings hook: subscribes to the host's settings service so the panel re-renders when
// OSC settings change. Falls back to an empty object before the host is set / in windows without one.
const EMPTY: OscSettings = {};
export function useHostSettings(): OscSettings {
  return useSyncExternalStore(
    (cb) => host?.settings.subscribe(cb) ?? (() => {}),
    () => (host ? (host.settings.get() as OscSettings) : EMPTY),
  );
}

// ── Scene3D: where TRIGGER ZONES live ────────────────────────────────────────────────────────────
// Zones are persisted PROJECT data (Scene3D.trackingZones — a core type; only the behaviour is ours),
// so the panel reads and writes them through the host's scene service rather than holding its own
// copy. App remains the single owner of the state, exactly as with every other core field.
//
// ⚠ The snapshot must be a STABLE REFERENCE between changes — useSyncExternalStore re-renders on any
// identity change, so returning a fresh `{}`/`[]` here would spin forever. `host.scene3D.get()` reads
// App's live state object, whose identity changes only when the scene actually changes; the frozen
// EMPTY_SCENE below covers the no-host case (projector windows) with the same guarantee.
const EMPTY_SCENE = Object.freeze({}) as Scene3D;
export function useHostScene3D(): Scene3D {
  return useSyncExternalStore(
    (cb) => host?.scene3D.subscribe(cb) ?? (() => {}),
    () => (host ? (host.scene3D.get() as Scene3D) : EMPTY_SCENE),
  );
}

// Commit an edited zone list back to the project. One writer, one shape — every zone mutation in the
// panel funnels through here so the plugin never spreads partial Scene3D patches around.
//
// THIS IS THE ROOM, AND IT IS PROJECT SCOPE. App strips `trackingZones` from a scene's look snapshot
// and preserves the live list across a recall, so writing here edits the venue once rather than
// whichever scene happens to be current (see App.buildSceneSnapshot / handleRecallScene).
export function setZones(next: TrackingZone[]): void {
  host?.scene3D.patch({ trackingZones: next } as Partial<Scene3D>);
}

// …and this is the LOOK's subscription to it: which zones the current scene listens to. Unlike the
// geometry above, this DOES travel with the scene, so it is captured by "Update Scene" and swapped on
// every GO. Passing `undefined` restores the default — every zone live.
export function setActiveZoneIds(next: string[] | undefined): void {
  host?.scene3D.patch({ activeZoneIds: next } as Partial<Scene3D>);
}
