// How this plugin's UI half reaches the rest of the app (E5/W5): the PluginLiveView and the PluginUiHost
// the host handed `activateUi`, kept here for the panels it registered.
//
// The OSC Monitor and the Trigger Zones are drawn in the editor AND in a panel window. What only the
// runtime knows (zone occupancy, the blobs, the people count) is published by `activate()` as the
// 'lidar-tracking.zoneView' stream and read through `liveView()`. The project they edit (the zones are
// Scene3D data) and the settings they show come through `uiHost()`: the editor's own services there,
// the window's replica — with every write sent to the editor — in a panel window.
//
// Never import trackingStore / zones / people / trackingHost from UI code: in a panel window those
// modules are idle copies that never received a packet (verify:invariants bundles the window to check).
import { useSyncExternalStore } from 'react';
import type { PluginLiveView, PluginUiHost } from '@artlux/sdk/renderer';
import type { Scene3D, TrackingZone } from '../../../shared/protocol';

let view: PluginLiveView | null = null;
let host: PluginUiHost | null = null;
export function setLiveView(v: PluginLiveView): void { view = v; }
export function liveView(): PluginLiveView | null { return view; }
export function setUiHost(h: PluginUiHost): void { host = h; }

// The subset of AppSettings the OSC Monitor reads. (AppSettings is a core type; we only need these.)
export interface OscSettings {
  oscEnabled?: boolean;
  oscListenPort?: number;
  oscListenAddress?: string;
}

// ⚠ Both snapshots must be STABLE REFERENCES between changes — useSyncExternalStore re-renders on any
// identity change, so a fresh `{}` here would spin forever. The host's get() returns the live object
// (the editor's state, or the replica's slice), whose identity changes only when it actually changes.
const EMPTY = Object.freeze({});
export function useHostSettings(): OscSettings {
  return useSyncExternalStore(
    (cb) => host?.settings.subscribe(cb) ?? (() => {}),
    () => ((host?.settings.get() as OscSettings | undefined) ?? EMPTY),
  );
}
export function useHostScene3D(): Scene3D {
  return useSyncExternalStore(
    (cb) => host?.scene3D.subscribe(cb) ?? (() => {}),
    () => ((host?.scene3D.get() as Scene3D | undefined) ?? (EMPTY as Scene3D)),
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

// WHAT A BLOB MEANS ON ONE SURFACE — the floor's legs vs the wall's hands. Project scope like the
// geometry above and for the same reason: it describes the SENSOR, and a GO must never change it.
// `undefined` clears the override so the surface follows the project-wide merge flag again.
export function setSurfaceMerge(surface: string, merge: boolean | undefined): void {
  const cur = (host?.scene3D.get() as Scene3D | undefined)?.trackingSurfaceMerge ?? {};
  const next: Record<string, boolean> = { ...cur };
  if (merge === undefined) delete next[surface]; else next[surface] = merge;
  host?.scene3D.patch({ trackingSurfaceMerge: next } as Partial<Scene3D>);
}

// …and this is the LOOK's subscription to it: which zones the current scene listens to. Unlike the
// geometry above, this DOES travel with the scene, so it is captured by "Update Scene" and swapped on
// every GO. Passing `undefined` restores the default — every zone live.
export function setActiveZoneIds(next: string[] | undefined): void {
  host?.scene3D.patch({ activeZoneIds: next } as Partial<Scene3D>);
}

/** Open a menu action's panel (a provider surface's calibration modal) — in the editor. */
export function runMenuAction(action: string): void { host?.ui.menuAction(action); }
