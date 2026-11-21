// The RUNTIME's half of the Trigger Zones panel's live view (E5/W5): builds a ZoneView from the stores
// the editor fills. Imported by plugin.renderer.ts only, never by UI code (see zoneView.ts).
import * as trackingStore from './trackingStore';
import * as zones from './zones';
import * as people from './people';
import { providerSurfaces, providerSurface } from './trackingHost';
import type { ZoneView } from './zoneView';

export function buildZoneView(surface: string): ZoneView {
  const states: ZoneView['states'] = {};
  for (const st of zones.getStates()) states[st.id] = { occupied: st.occupied, count: st.count };
  const providers = providerSurfaces().map((p) => ({
    key: p.key, label: p.label, parts: p.parts, calibrateAction: p.calibrateAction,
    available: p.available(), aspect: p.aspect?.() ?? 1, warning: p.warning?.() ?? null,
  }));
  const track = trackingStore.getSurfaceTrack(surface);
  const base = {
    states, surfaces: trackingStore.getSurfaces(), providers, venue: zones.getVenueDwell(), mergingAny: people.isMerging(),
    dims: track && track.scaleX && track.scaleY ? { scaleX: track.scaleX, scaleY: track.scaleY } : null,
  };
  // A provider surface: exactly what the zones count there — its tagged points. No blob diagnostics.
  if (providerSurface(surface)) {
    return {
      ...base,
      points: zones.surfacePoints(surface).map((p) => ({ u: p.u, v: p.v, part: p.part })),
      blobs: [], people: [], tally: { blobs: 0, people: 0 }, merging: false, gap: null, radius: people.radius(),
    };
  }
  const blobs: ZoneView['blobs'] = [];
  if (track) for (const b of track.blobs.values()) if (b.id !== 0) blobs.push({ u: b.u, v: b.v });
  return {
    ...base,
    points: [],
    blobs,
    people: people.get(surface).map((p) => ({ u: p.u, v: p.v })),
    tally: people.tally(surface),
    merging: people.isMerging(surface),
    gap: people.closestPairM(surface),
    radius: people.radius(),
  };
}
