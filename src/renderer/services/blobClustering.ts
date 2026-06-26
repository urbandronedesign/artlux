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

// ---- Predictive person tracker ----------------------------------------------
// The venue feed is noisy: per-blob ids flicker (~0.13 s median lifetime) and a person's far-apart
// blobs blink in and out, so the clustered centroid jumps ~1 m frame-to-frame even when the person is
// standing still. A naive "nearest previous within R" matcher loses the track on every jump and
// re-assigns ids constantly. This small multi-object tracker holds identity through that:
//   • predict — each track advances by its smoothed velocity, so we match where it *should* be
//   • associate — greedy nearest within GATE_M of the predicted position (wide enough for centroid jitter)
//   • confirm — a track is only emitted as a person after CONFIRM_HITS frames (rejects 1–3 frame flicker)
//   • coast — a confirmed track survives missed frames up to MAX_COAST_MS (rides through dropouts)
// Output positions come from the track (smoothed/predicted) → stable ids + steadier motion.
//
// Stateful: call ONCE per frame, from the App tracking bridge only (single window, single caller).
// tx/ty are metres, so all distances/velocities are real-world.

interface Track {
  id: number; tx: number; ty: number; vx: number; vy: number; px: number; py: number;
  lastSeen: number; hits: number; misses: number; confirmed: boolean;
}
interface SurfState { tracks: Track[]; lastNow: number; }
const state = new Map<string, SurfState>();
let nextPersonId = 1;

// Tunables (validated against an on-site 3–4 person recording).
const GATE_M = 1.5;            // association radius around a track's predicted position
const CONFIRM_HITS = 4;        // frames before a track counts as a real person (flicker rejection)
const MAX_COAST_MS = 700;      // keep a confirmed person alive this long through missed frames
const MAX_TENTATIVE_MS = 250;  // drop an unconfirmed track if it goes quiet this long
const POS_GAIN = 0.6;          // how much an observation corrects the predicted position
const VEL_GAIN = 0.25;         // velocity smoothing
const MAX_SPEED = 4;           // m/s — clamp so a centroid jump can't fling a track across the floor

// Clear all tracks (e.g. when merging is turned off) so a later re-enable starts fresh.
export function resetPeopleTracking(): void { state.clear(); nextPersonId = 1; }

function trackSurface(s: TrackingSnapshot['surfaces'][number], radiusM: number, now: number): Blob[] {
  const st = state.get(s.surface) ?? { tracks: [], lastNow: now };
  let dt = (now - st.lastNow) / 1000;
  if (!(dt > 0)) dt = 0.02;
  dt = Math.min(dt, 0.2); // clamp after a long gap so prediction can't fling a track across the room
  st.lastNow = now;

  const obs = clusterBlobs(s.blobs, radiusM); // per-frame observation centroids
  for (const t of st.tracks) { t.px = t.tx + t.vx * dt; t.py = t.ty + t.vy * dt; }

  // Greedy association: closest (track, observation) pairs first, within the gate.
  const pairs: { d: number; ti: number; oi: number }[] = [];
  for (let ti = 0; ti < st.tracks.length; ti++) {
    for (let oi = 0; oi < obs.length; oi++) {
      const dx = st.tracks[ti].px - obs[oi].tx, dy = st.tracks[ti].py - obs[oi].ty;
      const d = Math.hypot(dx, dy);
      if (d <= GATE_M) pairs.push({ d, ti, oi });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const tUsed = new Set<number>(), oUsed = new Set<number>();
  for (const p of pairs) {
    if (tUsed.has(p.ti) || oUsed.has(p.oi)) continue;
    tUsed.add(p.ti); oUsed.add(p.oi);
    const t = st.tracks[p.ti], o = obs[p.oi];
    t.vx += VEL_GAIN * ((o.tx - t.tx) / dt - t.vx);
    t.vy += VEL_GAIN * ((o.ty - t.ty) / dt - t.vy);
    const spd = Math.hypot(t.vx, t.vy);
    if (spd > MAX_SPEED) { t.vx *= MAX_SPEED / spd; t.vy *= MAX_SPEED / spd; }
    t.tx = t.px + POS_GAIN * (o.tx - t.px);
    t.ty = t.py + POS_GAIN * (o.ty - t.py);
    t.hits++; t.misses = 0; t.lastSeen = now;
    if (t.hits >= CONFIRM_HITS) t.confirmed = true;
  }
  // Unmatched tracks coast on their predicted position.
  for (let ti = 0; ti < st.tracks.length; ti++) {
    if (tUsed.has(ti)) continue;
    const t = st.tracks[ti]; t.tx = t.px; t.ty = t.py; t.misses++;
  }
  // Unmatched observations seed new (tentative) tracks.
  for (let oi = 0; oi < obs.length; oi++) {
    if (oUsed.has(oi)) continue;
    const o = obs[oi];
    st.tracks.push({ id: nextPersonId++, tx: o.tx, ty: o.ty, vx: 0, vy: 0, px: o.tx, py: o.ty, lastSeen: now, hits: 1, misses: 0, confirmed: false });
  }
  st.tracks = st.tracks.filter((t) => now - t.lastSeen <= (t.confirmed ? MAX_COAST_MS : MAX_TENTATIVE_MS));
  state.set(s.surface, st);

  // Emit confirmed tracks as people (stable id; u/v recomputed from the tracked metres).
  const sx = s.scaleX || 5.864, sy = s.scaleY || 3.125;
  return st.tracks.filter((t) => t.confirmed).map((t) => ({
    slot: t.id, id: t.id, tx: t.tx, ty: t.ty, u: t.tx / sx + 0.5, v: t.ty / sy + 0.5, updatedAt: now,
  }));
}

// Cluster + track into stable people. Returns a snapshot whose blobs ARE the tracked people.
export function clusterAndTrack(snap: TrackingSnapshot, radiusM: number, now: number): TrackingSnapshot {
  return { surfaces: snap.surfaces.map((s) => ({ ...s, blobs: trackSurface(s, radiusM, now) })) };
}
