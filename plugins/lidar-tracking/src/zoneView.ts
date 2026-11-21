// WHAT THE TRIGGER ZONES PANEL SHOWS OF THE RUNTIME (E5/W5) — one plain, structured-cloneable frame.
//
// The panel is drawn in the editor and in a panel window; the zones are EVALUATED only in the editor,
// where OSC arrives and the tracking stores fill. So the runtime builds this frame (plugin.renderer.ts,
// the 'lidar-tracking.zoneView' stream, params = the surface on the map) and the panel paints from it,
// in both windows — one code path. The broker sends a window at most one frame per frame it draws.
//
// Types only: this file is imported by the UI half, and must stay free of anything that runs.

export interface ZoneStateView { occupied: boolean; count: number }

/** Another plugin's tracking surface (the camera area), as data — its functions do not cross windows. */
export interface ZoneProviderView {
  key: string;
  label: string;
  parts?: { id: string; label: string }[];
  calibrateAction?: string;
  available: boolean;
  aspect: number;
  warning: string | null;
}

export interface ZoneView {
  /** Per zone id: the latched occupancy and the raw count. */
  states: Record<string, ZoneStateView>;
  /** The LiDAR surfaces the tracker has reported. */
  surfaces: string[];
  providers: ZoneProviderView[];
  /** Venue enter/exit dwell (the zones' defaults). */
  venue: { enterSec: number; exitSec: number };
  /** Whether blobs are merged into people anywhere (the project-wide flag). */
  mergingAny: boolean;
  // ── for the surface asked for ──
  /** Its size in metres, when the tracker has said. */
  dims: { scaleX: number; scaleY: number } | null;
  /** A provider surface's points (tagged body parts). Empty on a LiDAR surface. */
  points: { u: number; v: number; part?: string }[];
  /** Raw blobs, NOT people-merged — the diagnostic view. */
  blobs: { u: number; v: number }[];
  /** The people the zones count. */
  people: { u: number; v: number }[];
  tally: { blobs: number; people: number };
  merging: boolean;
  /** Closest pair of blobs, metres — compared against the merge radius. */
  gap: number | null;
  radius: number;
}

export const EMPTY_ZONE_VIEW: ZoneView = {
  states: {}, surfaces: [], providers: [], venue: { enterSec: 0, exitSec: 0 }, mergingAny: false,
  dims: null, points: [], blobs: [], people: [], tally: { blobs: 0, people: 0 }, merging: false, gap: null, radius: 0,
};

/** What changes the panel's React tree (the list, the toolbar) — the rest is only painted. */
export function zoneViewKey(v: ZoneView): string {
  return JSON.stringify([v.states, v.surfaces, v.providers, v.venue, v.mergingAny, v.dims]);
}
