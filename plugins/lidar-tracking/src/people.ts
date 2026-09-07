import * as trackingStore from './trackingStore';
import type { TrackingSnapshot } from './trackingStore';
import { clusterAndTrack, resetPeopleTracking } from './blobClustering';

// PEOPLE — the venue's blobs turned into visitors, computed ONCE per frame, read by everyone.
//
// ── WHY THIS MODULE EXISTS ───────────────────────────────────────────────────────────────────────
// The venue's LiDAR emits ~2 blobs PER PERSON, so anything counting raw blobs counts double. Two
// consumers need the corrected number and they used to compute it SEPARATELY, with different
// algorithms:
//
//   the projector data channel → clusterAndTrack()  — spatial merge + the predictive person tracker
//   trigger zones              → clusterBlobs()     — the spatial merge alone
//
// So the number an operator VALIDATED against (markers in the 3D scene) was not the number the SHOW
// acted on. On a feed whose blob ids have a ~0.13 s median lifetime that is not a nuance: the tracker
// exists precisely because the clustered centroid jumps ~1 m frame-to-frame while somebody stands
// still, and the zone count had none of that protection.
//
// zones.ts declined to call clusterAndTrack for a correct reason — it owns per-frame velocity state
// and is documented "call ONCE per frame, from a single caller", so a second caller would advance
// every track twice against a ~0 dt and make the projector's markers visibly jitter as a side effect
// of a zone existing. The answer is not a weaker algorithm in the path that drives the show; it is to
// BE that single caller, here, and hand the same answer to both.
//
// ── AND IT UNIFIES WHAT "A LIVE BLOB" MEANS ──────────────────────────────────────────────────────
// This reads trackingStore.snapshot(), which drops `id === 0` (a free slot) AND anything not updated
// for STALE_TTL_MS. The zone path used getSurfaceTrack() and filtered only `id === 0`, so a blob the
// sensor stopped updating WITHOUT releasing its slot held a zone occupied forever — nothing in the
// dwell model can release it, because as far as the zone was concerned somebody was still standing
// there. Both consumers now agree on which blobs are real.
//
// Render-free singleton, like trackingStore and zones: refreshed from the host's per-frame callback,
// never from React.

let mergePeople = false;
let radiusM = 0.8;
// Per-surface opt-out of merging (Scene3D.trackingSurfaceMerge). `false` for a surface means a blob
// there is already one whole thing — a HAND on the wall, not half a person on the floor.
let surfaceMerge: Record<string, boolean> = {};

// The last frame's answer. `snap` is what the projector channel bridges; `points` is the same thing
// reduced to what a zone needs (normalized positions), per surface, so zones.evaluate does no work
// per zone beyond a rect test.
let snap: TrackingSnapshot = { surfaces: [] };
const points = new Map<string, { u: number; v: number }[]>();
const rawCounts = new Map<string, number>();
// The closest two RAW blobs on each surface, in metres. Kept because it is the ONE number that says
// whether the merge radius is right for a given venue, and there was no way to see it: if a person's
// two blobs sit further apart than the radius they never merge, the count stays doubled, and the only
// symptom is a threshold that means half what was typed. Guessing at the radius is the alternative.
const closestPair = new Map<string, number>();

// Merge settings ride the SENSOR, not the look — see SCENE3D_NOT_A_LOOK in App.tsx. Turning merging
// off drops the tracker's state so a later re-enable starts from an empty floor rather than resuming
// tracks for people who have long gone.
export function configure(merge: boolean, radius: number, perSurface?: Record<string, boolean>): void {
  if (mergePeople && !merge) resetPeopleTracking();
  mergePeople = merge;
  radiusM = radius;
  surfaceMerge = perSurface ?? {};
}

// Is THIS surface's blob half a person (merge) or a whole one (a hand)? An absent entry follows the
// project-wide flag, so every project written before per-surface meaning behaves exactly as it did.
export function isMerging(surface?: string): boolean {
  if (!mergePeople) return false;
  return surface === undefined ? true : surfaceMerge[surface] !== false;
}

// Call ONCE per frame, from the main window, BEFORE anything reads. This is the single caller the
// tracker's contract asks for.
export function refresh(nowMs: number): void {
  const raw = trackingStore.snapshot();
  if (!mergePeople) {
    // The tracker only runs when the operator has actually asked for people. Untouched legacy path:
    // raw blobs, byte-for-byte what the zones saw before, and no tracker state advances at all.
    snap = raw;
  } else {
    // TWO PASSES, BY MEANING, because one radius cannot describe a venue whose floor sees legs and
    // whose wall sees hands. Surfaces that merge run at the authored radius; surfaces opted out run at
    // radius 0 — which is NOT the same as skipping them. clusterBlobs returns its input unchanged at
    // radius 0, so an opted-out surface is still tracked: flicker rejection and coasting, no merging.
    // A hand the sensor drops for a frame must not drop the trigger.
    //
    // The two calls are safe together because trackSurface keys its state BY SURFACE and the two sets
    // are disjoint — every surface is still advanced exactly once per frame, which is the contract.
    const merged = raw.surfaces.filter((s) => surfaceMerge[s.surface] !== false);
    const whole = raw.surfaces.filter((s) => surfaceMerge[s.surface] === false);
    const out = new Map<string, TrackingSnapshot['surfaces'][number]>();
    if (merged.length) for (const s of clusterAndTrack({ surfaces: merged }, radiusM, nowMs).surfaces) out.set(s.surface, s);
    if (whole.length) for (const s of clusterAndTrack({ surfaces: whole }, 0, nowMs).surfaces) out.set(s.surface, s);
    snap = { surfaces: raw.surfaces.map((s) => out.get(s.surface) ?? s) };
  }

  points.clear();
  rawCounts.clear();
  closestPair.clear();
  for (const s of raw.surfaces) {
    rawCounts.set(s.surface, s.blobs.length);
    // O(n²) over a handful of blobs, on the same list the clustering already walks. tx/ty are metres
    // about the surface centre, so this is a real-world distance and directly comparable to the radius.
    let best = Infinity;
    for (let i = 0; i < s.blobs.length; i++)
      for (let j = i + 1; j < s.blobs.length; j++)
        best = Math.min(best, Math.hypot(s.blobs[i].tx - s.blobs[j].tx, s.blobs[i].ty - s.blobs[j].ty));
    if (Number.isFinite(best)) closestPair.set(s.surface, best);
  }
  for (const s of snap.surfaces) points.set(s.surface, s.blobs.map((b) => ({ u: b.u, v: b.v })));
}

// The merge radius currently in force, so a readout can put the two numbers side by side.
export function radius(): number { return radiusM; }

// Metres between the two closest raw blobs on this surface, or null with fewer than two. Stand ONE
// person on the sensor and this is the gap between their own two blobs — if it exceeds the merge
// radius, that is the whole reason the count is doubled, and it is the number to raise the radius past.
export function closestPairM(surface: string): number | null {
  const d = closestPair.get(surface);
  return d === undefined ? null : d;
}

// What the projector data channel bridges to output windows.
export function snapshot(): TrackingSnapshot { return snap; }

// What a zone counts: one entry per PERSON on that surface (per blob when merging is off).
export function get(surface: string): { u: number; v: number }[] { return points.get(surface) ?? []; }

// Both numbers, for the Trigger Zones panel's live readout. Seeing "4 blobs → 2 people" is what makes
// a doubled count self-evident; no amount of prose about merging does the same job.
export function tally(surface: string): { blobs: number; people: number } {
  return { blobs: rawCounts.get(surface) ?? 0, people: points.get(surface)?.length ?? 0 };
}

// Drop everything, tracker included. Paired with zones.reset() at a take boundary: a recorded take
// replaces the whole store, and carrying tracks across that would coast people who were never there
// into the first frames of the take (MAX_COAST_MS keeps a confirmed person alive for 700 ms).
export function reset(): void {
  resetPeopleTracking();
  snap = { surfaces: [] };
  points.clear();
  rawCounts.clear();
  closestPair.clear();
}
