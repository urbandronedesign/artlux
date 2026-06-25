import type { Blob, TrackingSnapshot } from './trackingStore';

// Spatial blob clustering — the venue's LiDAR emits ~2 blobs per person on the floor (each with its
// OWN id), so without merging a single person shows up as two markers and is double-counted. This
// merges a surface's blobs whose centres sit within `radiusM` metres into one "person" (the
// centroid). Pure functions — no temporal state — so they can be called multiple times per frame.
//
// Applied at the snapshot bridge in App.tsx (scene + projector consume the merged result), leaving
// the raw store and recorded takes untouched. tx/ty are metres about the zone centre, so distance
// is real-world; fixed-radius around each unused seed avoids long single-link chains across a crowd.

function mergeGroup(group: Blob[]): Blob {
  const n = group.length;
  let tx = 0, ty = 0, u = 0, v = 0, updatedAt = 0;
  let id = group[0].id, slot = group[0].slot;
  for (const b of group) {
    tx += b.tx; ty += b.ty; u += b.u; v += b.v;
    if (b.updatedAt > updatedAt) updatedAt = b.updatedAt;
    if (b.id < id) id = b.id;       // smallest constituent id → stable person id while blobs persist
    if (b.slot < slot) slot = b.slot;
  }
  return { slot, id, tx: tx / n, ty: ty / n, u: u / n, v: v / n, updatedAt };
}

// Merge blobs within `radiusM` metres into people (centroids). radiusM <= 0 returns the input.
export function clusterBlobs(blobs: Blob[], radiusM: number): Blob[] {
  if (!(radiusM > 0) || blobs.length < 2) return blobs;
  const r2 = radiusM * radiusM;
  const used = new Array<boolean>(blobs.length).fill(false);
  const out: Blob[] = [];
  for (let i = 0; i < blobs.length; i++) {
    if (used[i]) continue;
    const seed = blobs[i];
    const group: Blob[] = [seed];
    used[i] = true;
    for (let j = i + 1; j < blobs.length; j++) {
      if (used[j]) continue;
      const dx = seed.tx - blobs[j].tx, dy = seed.ty - blobs[j].ty;
      if (dx * dx + dy * dy <= r2) { group.push(blobs[j]); used[j] = true; }
    }
    out.push(group.length === 1 ? seed : mergeGroup(group));
  }
  return out;
}

// Cluster every surface of a snapshot (pure — used in tests; the bridge uses clusterAndTrack).
export function clusterSnapshot(snap: TrackingSnapshot, radiusM: number): TrackingSnapshot {
  return { surfaces: snap.surfaces.map((s) => ({ ...s, blobs: clusterBlobs(s.blobs, radiusM) })) };
}

// ---- Temporal person tracking -----------------------------------------------
// Give each merged person a STABLE id by matching this frame's centroids to the previous frame's
// people by proximity. Without this, the person id (smallest constituent blob id) jumps whenever one
// of the underlying blobs drops/reacquires — even though the person never left. With it, the centroid
// stays continuous so the id carries over, keeping `#id` labels and per-person smoothing stable.
//
// Stateful: call ONCE per frame, from the App tracking bridge only (single window, single caller).
// tx/ty are metres, so the match radius is real-world.

interface TrackedPerson { id: number; tx: number; ty: number; lastSeen: number; }
const tracks = new Map<string, TrackedPerson[]>(); // per surface
let nextPersonId = 1;
const MATCH_RADIUS_M = 0.8; // max plausible per-frame move + brief-gap tolerance
const TRACK_TTL_MS = 400;   // keep a vanished person this long so a 1–2 frame dropout re-matches

// Clear all tracks (e.g. when merging is turned off) so a later re-enable starts fresh.
export function resetPeopleTracking(): void { tracks.clear(); nextPersonId = 1; }

// Cluster each surface into people and assign stable person ids (overwriting blob `id`). Person ids
// are always >= 1 (so they read as active in trackingStore, which treats id 0 as inactive).
export function clusterAndTrack(snap: TrackingSnapshot, radiusM: number, now: number): TrackingSnapshot {
  const r2 = MATCH_RADIUS_M * MATCH_RADIUS_M;
  return {
    surfaces: snap.surfaces.map((s) => {
      const merged = clusterBlobs(s.blobs, radiusM);
      const prev = (tracks.get(s.surface) ?? []).filter((p) => now - p.lastSeen <= TRACK_TTL_MS);
      const used = new Set<number>();
      const next: TrackedPerson[] = [];
      const blobs = merged.map((b) => {
        // Nearest unused previous person within the match radius carries its id forward.
        let best = -1, bestD = r2;
        for (let i = 0; i < prev.length; i++) {
          if (used.has(i)) continue;
          const dx = prev[i].tx - b.tx, dy = prev[i].ty - b.ty, d = dx * dx + dy * dy;
          if (d <= bestD) { bestD = d; best = i; }
        }
        const id = best >= 0 ? (used.add(best), prev[best].id) : nextPersonId++;
        next.push({ id, tx: b.tx, ty: b.ty, lastSeen: now });
        return { ...b, id };
      });
      tracks.set(s.surface, next);
      return { ...s, blobs };
    }),
  };
}
