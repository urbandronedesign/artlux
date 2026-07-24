import type { TrackingZone } from '../../../shared/protocol';
import * as trackingStore from './trackingStore';
import { clusterBlobs } from './blobClustering';

// TRIGGER ZONES — "is anybody standing there?", answered once per frame, with hysteresis.
//
// The show machine reacts to people through this module: a zone is a normalized rect on a tracking
// surface (Scene3D.trackingZones, a core persisted type), and this turns the live blob store into a
// latched occupancy state plus ENTER/EXIT edges the FSM's plugin triggers read.
//
// Render-free singleton, exactly like trackingStore: evaluated from the host's per-frame callback and
// published through subscribe(), so a person walking across a room never re-renders React.
//
// ── WHY THE COUNT IS CLUSTERED, AND WHY NOT WITH THE PEOPLE TRACKER ──────────────────────────────
// The venue's LiDAR emits ~2 blobs PER PERSON, so a raw blob count double-counts everyone and every
// threshold an operator authors would mean half what they typed. So the count goes through
// clusterBlobs() — the PURE, stateless merge.
//
// It deliberately does NOT use clusterAndTrack(): that one owns a multi-object tracker with per-frame
// velocity state and is documented "call ONCE per frame, from a single caller" (the projector data
// channel already is that caller). Calling it again here would advance every track twice per frame
// against a ~0 dt — the predictions would fling, ids would churn, and the projector's markers would
// visibly jitter as a side effect of a zone existing. Occupancy does not need stable identities
// anyway: it needs a COUNT, and the temporal stability comes from the enter/exit dwell below.
//
// ── HYSTERESIS IS THE FEATURE, AND "CONTINUOUS" WOULD BREAK IT ───────────────────────────────────
// A bare "is a blob inside the rect" test fires on every flicker of a tracker whose blob ids have a
// ~0.13 s median lifetime — a person standing on a zone edge would trigger the show dozens of times a
// minute. So a zone must dwell. But the obvious dwell — "count >= minBlobs CONTINUOUSLY for enterSec"
// — is worse than no dwell at all on this feed: at a 0.2 s enter dwell against ~0.13 s dropouts the
// timer is reset before it can ever expire and NOBODY EVER TRIGGERS ANYTHING. (Measured in
// scratch/zone-rules-sim.mjs: 240 frames of a person standing still with a dropout every 7th frame →
// enterSeq 0.)
//
// So presence is modelled as a RUN that survives gaps, with `exitSec` doing double duty as the
// gap tolerance — which is what it already means: "how long an absence must last before we believe
// it". Three timestamps, and every rule falls out of them:
//
//   lastSeenMs  — the last frame the zone had enough people in it
//   runStartMs  — when the CURRENT presence run began (survives gaps shorter than exitSec)
//   occupied    — latched: set once a run is enterSec old, cleared once the absence is exitSec old
//
// Quick to react, slow to release — the usual shape for an installation — is then just a small
// enterSec and a larger exitSec.

export interface ZoneState {
  id: string;
  count: number;          // people currently inside (post-merge), raw — no dwell applied
  occupied: boolean;      // the LATCHED state, after enter/exit dwell
  occupiedSinceMs: number; // when `occupied` last became true (0 when not occupied)
  emptySinceMs: number;    // when `occupied` last became false (0 when occupied)
  // Monotonic edge counters. THIS is what makes a trigger an EDGE rather than a level: a state
  // re-entered while someone is already standing in the zone must not fire instantly, so the trigger
  // compares these against the value captured when the state was entered. A boolean cannot express
  // "it happened again" — two enters with an exit between them look identical to one.
  enterSeq: number;
  exitSeq: number;
}

const DEF_MIN_BLOBS = 1;
const DEF_ENTER_SEC = 0.2;   // ultimate fallback when neither the venue nor the zone sets a dwell
const DEF_EXIT_SEC = 0.5;

let zones: TrackingZone[] = [];
let mergePeople = false;
let mergeRadius = 0.8;
// VENUE-WIDE dwell (Scene3D.trackingZoneEnterSec/ExitSec) — the default every zone follows unless it
// carries its own override. Tuned once, on-site, in the tracking parameters. See configure().
let venueEnterSec = DEF_ENTER_SEC;
let venueExitSec = DEF_EXIT_SEC;
// WHICH ZONES THE CURRENT LOOK LISTENS TO (Scene3D.activeZoneIds). `null` = every zone, which is what an
// absent field means and what every project written before per-scene zones existed gets.
let activeIds: Set<string> | null = null;

const states = new Map<string, ZoneState>();
const subs = new Set<() => void>();
// Presence bookkeeping per zone — see the hysteresis note above. Both are 0 when there is no run.
interface Presence { lastSeenMs: number; runStartMs: number }
const presence = new Map<string, Presence>();

const blank = (id: string): ZoneState => ({ id, count: 0, occupied: false, occupiedSinceMs: 0, emptySinceMs: 0, enterSeq: 0, exitSeq: 0 });

// Push the authored zones + the people-merge settings + this look's active set (all from Scene3D).
// Zone states are kept across a re-configure so editing a zone's NAME or COLOUR does not re-fire its
// triggers; a zone that disappears — or that this look does not listen to — takes its state with it.
export function configure(next: TrackingZone[] | undefined, merge: boolean, radiusM: number, active?: string[], enterSec?: number, exitSec?: number): void {
  zones = Array.isArray(next) ? next : [];
  mergePeople = merge;
  mergeRadius = radiusM;
  // Guard the venue dwell: a hand-edited or missing value must not poison the clock. A non-finite or
  // negative number falls back to the shipped default rather than making every zone's latch never fire
  // (a 0 enter is legal — "latch the instant presence is seen" — so only reject < 0 and non-finite).
  venueEnterSec = typeof enterSec === 'number' && Number.isFinite(enterSec) && enterSec >= 0 ? enterSec : DEF_ENTER_SEC;
  venueExitSec = typeof exitSec === 'number' && Number.isFinite(exitSec) && exitSec >= 0 ? exitSec : DEF_EXIT_SEC;
  // An absent list means EVERY zone (back-compat, and the sane default for a project with one look).
  // An empty ARRAY is a real answer — this look listens to nothing — so only `undefined` opts out.
  activeIds = Array.isArray(active) ? new Set(active) : null;
  // Drop the state of anything that is gone OR no longer listened to. Clearing (rather than freezing) is
  // the point: a zone that comes back live must re-arm FROM EMPTY, or it would report somebody who was
  // standing there when the previous scene handed over — a phantom the show would act on.
  for (const id of [...states.keys()]) if (!isActive(id)) { states.delete(id); presence.delete(id); }
}

// Is this zone both present and listened to by the current look?
function isActive(id: string): boolean {
  return zones.some((z) => z.id === id) && (!activeIds || activeIds.has(id));
}
export function isZoneActive(id: string): boolean { return isActive(id); }

export function getZones(): TrackingZone[] { return zones; }
// The venue-wide dwell a zone falls back to — so the panel can show the inherited value on a zone that
// carries no override of its own.
export function getVenueDwell(): { enterSec: number; exitSec: number } { return { enterSec: venueEnterSec, exitSec: venueExitSec }; }
export function getState(zoneId: string): ZoneState | undefined { return states.get(zoneId); }
export function getStates(): ZoneState[] { return [...states.values()]; }
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

// Is (u,v) inside the zone? Corners are normalized against the authored rect either way round, so a
// zone dragged right-to-left or bottom-to-top still contains what it visibly encloses — the editor
// normalizes on commit, but a hand-edited project is exactly this sanitiser's threat model.
const inside = (z: TrackingZone, u: number, v: number): boolean =>
  u >= Math.min(z.u0, z.u1) && u <= Math.max(z.u0, z.u1) &&
  v >= Math.min(z.v0, z.v1) && v <= Math.max(z.v0, z.v1);

// Advance every zone one frame. Call ONCE per frame from the main window.
export function evaluate(nowMs: number): void {
  if (zones.length === 0) return; // the no-zones cost is one compare
  let changed = false;

  // Count per surface once, not per zone: several zones normally share a surface, and clusterBlobs is
  // O(n²) in that surface's blob count.
  const perSurface = new Map<string, { u: number; v: number }[]>();
  for (const z of zones) {
    if (activeIds && !activeIds.has(z.id)) continue;   // this look does not listen to it — don't even count
    if (perSurface.has(z.surface)) continue;
    const track = trackingStore.getSurfaceTrack(z.surface);
    const raw = track ? [...track.blobs.values()].filter((b) => b.id !== 0) : [];
    const merged = mergePeople ? clusterBlobs(raw, mergeRadius) : raw;
    perSurface.set(z.surface, merged.map((b) => ({ u: b.u, v: b.v })));
  }

  for (const z of zones) {
    // Inactive for this look: no state at all (configure() already deleted it), so getState() returns
    // undefined and every rule naming it is inert. Not "occupied: false" — an inactive zone must be
    // UNANSWERABLE, not answered "empty", or an `exit`/`emptyFor` rule would fire on a look that was
    // never listening to that part of the room.
    if (activeIds && !activeIds.has(z.id)) continue;
    const pts = perSurface.get(z.surface) ?? [];
    let count = 0;
    for (const p of pts) if (inside(z, p.u, p.v)) count++;

    const st = states.get(z.id) ?? blank(z.id);
    if (st.count !== count) { st.count = count; changed = true; }

    const enough = count >= (z.minBlobs ?? DEF_MIN_BLOBS);
    // A zone's own dwell is an OVERRIDE; absent, it follows the venue-wide value tuned in the tracking
    // parameters. minBlobs stays per-zone (a crowd zone and a tripwire want different thresholds).
    const enterMs = (z.enterSec ?? venueEnterSec) * 1000;
    const exitMs = (z.exitSec ?? venueExitSec) * 1000;
    const pr = presence.get(z.id) ?? { lastSeenMs: 0, runStartMs: 0 };

    if (enough) {
      pr.lastSeenMs = nowMs;
      if (!pr.runStartMs) pr.runStartMs = nowMs;       // a new presence run begins
    } else if (pr.runStartMs && nowMs - pr.lastSeenMs >= exitMs) {
      pr.runStartMs = 0;                               // the gap outlasted exitSec — the run is really over
    }
    presence.set(z.id, pr);

    // Latch ON once the RUN (not an unbroken stretch of frames) is old enough; latch OFF once the
    // absence is. Both edges bump a counter — see ZoneState.enterSeq.
    if (!st.occupied && pr.runStartMs && nowMs - pr.runStartMs >= enterMs) {
      st.occupied = true; st.enterSeq++; st.occupiedSinceMs = nowMs; st.emptySinceMs = 0;
      changed = true;
    } else if (st.occupied && !pr.runStartMs) {
      st.occupied = false; st.exitSeq++; st.emptySinceMs = nowMs; st.occupiedSinceMs = 0;
      changed = true;
    }
    states.set(z.id, st);
  }

  if (changed) for (const cb of subs) { try { cb(); } catch (e) { console.error('[zones] subscriber error', e); } }
}

// Drop all latched state (zones re-arm from empty). Used when the tracking source changes under us —
// a take starting or ending replaces the whole store, and carrying "occupied" across that would fire
// an exit edge for a person who never left, or hold one who was never there.
export function reset(): void {
  states.clear();
  presence.clear();
}
