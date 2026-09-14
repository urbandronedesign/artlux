// People, as numbers a shader can read.
//
// ── WHAT IT READS ────────────────────────────────────────────────────────────────────────────────
// The LiDAR plugin's PEOPLE — blobs merged into visitors and tracked with stable ids, computed once per
// frame by people.refresh() — not the raw OSC blobs. That is the same answer the trigger zones count and
// the projectors draw, so a shader reacting to "a person" agrees with every other thing in the show that
// uses the word. It also means a recorded take replayed on the timeline drives a shader exactly as a
// live room does, which is how anyone authors one without a crowd.
//
// ── THE SEAM ─────────────────────────────────────────────────────────────────────────────────────
// Imported through the lidar plugin's BARREL, never a deep path: `people` holds the tracker, and a
// second module identity would be a tracker nobody refreshes — a shader that sees an empty floor. (The
// audio tap meets its plugin at an IPC name instead because that plugin owns a native handle; this one
// is renderer-only state, and the barrel is the rule for exactly this.)
//
// ── THE LAYOUT ───────────────────────────────────────────────────────────────────────────────────
// Three SLOTS, one per tracking surface the protocol defines — floor (SOL), wall (MUR), combined
// (SOL_MUR) — each with MAX_PEOPLE entries, flattened as slot * MAX_PEOPLE + index:
//
//   iPeople[k]       = u, v, heading (radians), headingValid     — zone uv, bottom-left, Y up
//   iPeopleMotion[k] = vx, vy (m/s), id (0 = empty), age (s)
//   iPeopleCount[s]  = how many entries in the slot are live
//   iTrackZone[s]    = zone width, height in metres
//
// STABLE INDICES. A person keeps their index for as long as they are tracked and a newcomer takes the
// lowest free one. Packing the live people densely instead would renumber everyone behind a person who
// leaves, so "person 0" in a graph would jump across the floor to wherever person 1 was standing. The
// price is holes, which is why a node reads `active` rather than trusting the count as a loop bound.
//
// ── WHERE IT RUNS ────────────────────────────────────────────────────────────────────────────────
// The main window fills the buffers once per frame (update) from people.snapshot(). A projector
// window never sees OSC and has no tracker, so it is sent the buffers over the 'shader-tracking'
// projector channel (toPayload / applyPayload) and renders from those.

import { people } from '@artlux/plugin-lidar-tracking';

export const MAX_PEOPLE = 16;
/** Slot order is the GLSL contract: 0 floor, 1 wall, 2 floor+wall. */
export const SLOTS = ['SOL', 'MUR', 'SOL_MUR'] as const;
const N = SLOTS.length * MAX_PEOPLE;

// The venue's zone size when a sensor has not sent its specs yet — the same fallback the tracker uses
// (blobClustering.trackSurface), so a metre means the same thing here as it did when u/v were computed.
const DEFAULT_ZONE: [number, number] = [5.864, 3.125];

const pos = new Float32Array(N * 4);
const motion = new Float32Array(N * 4);
const count = new Int32Array(SLOTS.length);
const zone = new Float32Array(SLOTS.length * 2);
// Zeros for an offline render — see peoplePos().
const emptyPos = new Float32Array(N * 4);
const emptyMotion = new Float32Array(N * 4);
const emptyCount = new Int32Array(SLOTS.length);

// Bumped whenever the buffers may have changed — see generation().
let gen = 0;
let anyoneLastFrame = false;

// Per slot: which person id owns each index (0 = free).
const owners: Int32Array[] = SLOTS.map(() => new Int32Array(MAX_PEOPLE));
const seen = new Set<number>();

for (let s = 0; s < SLOTS.length; s++) { zone[s * 2] = DEFAULT_ZONE[0]; zone[s * 2 + 1] = DEFAULT_ZONE[1]; }

/** Main window, once per frame, AFTER people.refresh(). */
export function update(nowMs: number): void {
  const snap = people.snapshot();
  for (let s = 0; s < SLOTS.length; s++) {
    const surf = snap.surfaces.find((x) => x.surface === SLOTS[s]);
    const own = owners[s];
    const base = s * MAX_PEOPLE;
    if (surf) {
      if (surf.scaleX > 0) zone[s * 2] = surf.scaleX;
      if (surf.scaleY > 0) zone[s * 2 + 1] = surf.scaleY;
    }
    const blobs = surf?.blobs ?? [];

    // Release the indices of people who are gone, before anyone new claims one.
    seen.clear();
    for (const b of blobs) if (b.id > 0) seen.add(b.id);
    for (let i = 0; i < MAX_PEOPLE; i++) if (own[i] !== 0 && !seen.has(own[i])) own[i] = 0;

    let live = 0;
    for (const b of blobs) {
      if (!(b.id > 0)) continue;
      let i = own.indexOf(b.id);
      if (i < 0) {
        i = own.indexOf(0);
        // More people than slots: the extra ones are not drawn. Silently, per frame — a log here would
        // fire sixty times a second in exactly the busy moment nobody is reading it. Documented instead.
        if (i < 0) continue;
        own[i] = b.id;
      }
      const k = (base + i) * 4;
      pos[k] = b.u; pos[k + 1] = b.v; pos[k + 2] = b.heading ?? 0; pos[k + 3] = b.headingValid ?? 0;
      motion[k] = b.vx ?? 0; motion[k + 1] = b.vy ?? 0; motion[k + 2] = b.id;
      motion[k + 3] = b.bornAt !== undefined ? Math.max(0, (nowMs - b.bornAt) / 1000) : 0;
      live++;
    }
    // Clear the free indices, so a shader reading an empty one gets id 0 and not a ghost.
    for (let i = 0; i < MAX_PEOPLE; i++) {
      if (own[i] !== 0) continue;
      const k = (base + i) * 4;
      pos.fill(0, k, k + 4);
      motion.fill(0, k, k + 4);
    }
    count[s] = live;
  }
  // The frame the last person left still changes the picture; every empty frame after it does not.
  const anyone = count[0] + count[1] + count[2] > 0;
  if (anyone || anyoneLastFrame) gen++;
  anyoneLastFrame = anyone;
}

/**
 * Changes when the people did — joined into a shader's cache signature (shaderDrawable.getFor) so an
 * interactive shader keeps drawing while the transport is paused, and an empty room costs nothing.
 */
export function generation(): number { return gen; }

// Does this source read the people at all? Cached on the last text asked about: getFor runs per surface
// per frame, and scanning a few KB of GLSL each time to answer a question whose answer only changes on
// an edit would be work for nothing. Most projects ask about one or two sources.
const readsCache = new Map<string, boolean>();
export function readsPeople(source: string): boolean {
  let hit = readsCache.get(source);
  if (hit === undefined) {
    hit = /\b(iPeople|iPeopleMotion|iPeopleCount|iTrackZone)\b/.test(source);
    if (readsCache.size > 64) readsCache.clear(); // a live edit mints a new key per keystroke
    readsCache.set(source, hit);
  }
  return hit;
}

export interface TrackingPayload { pos: Float32Array; motion: Float32Array; count: Int32Array; zone: Float32Array }

/** Main window → projector windows. Structured clone copies the arrays, so sending the live ones is safe. */
export function toPayload(): TrackingPayload { return { pos, motion, count, zone }; }

/** Projector window: adopt what the main window computed. */
export function applyPayload(p: TrackingPayload): void {
  if (!p || !p.pos || p.pos.length !== pos.length || p.motion.length !== motion.length) return;
  pos.set(p.pos);
  motion.set(p.motion);
  if (p.count?.length === count.length) count.set(p.count);
  if (p.zone?.length === zone.length) zone.set(p.zone);
  const anyone = count[0] + count[1] + count[2] > 0;
  if (anyone || anyoneLastFrame) gen++;
  anyoneLastFrame = anyone;
}

// ── For the uniform upload. Live arrays — read them, do not keep them. ──
// `offline` returns an EMPTY room: a non-realtime render must be reproducible, and a room is not. Two
// bakes of the same range would otherwise differ by whoever happened to be walking past the sensor.
export function peoplePos(offline: boolean): Float32Array { return offline ? emptyPos : pos; }
export function peopleMotion(offline: boolean): Float32Array { return offline ? emptyMotion : motion; }
export function peopleCount(offline: boolean): Int32Array { return offline ? emptyCount : count; }
export function trackZone(): Float32Array { return zone; }
