// Augmenta object store — the renderer-side sink for the Augmenta box's OSC tracking stream.
// Singleton pub/sub like the LiDAR trackingStore / MediaPipe poseStore: render-free, so high-rate
// object updates never trigger React re-renders. Consumers (the stage drawable, projector render,
// 3D viz, monitor) subscribe and read the current object set.
//
// PROTOCOL — Augmenta OSC v2 / Fusion. Augmenta Fusion (or a Node) streams, per tracking frame, a
// scene message plus one message per tracked object. Unlike the LiDAR protocol (one leaf value per
// message, accumulated per slot), Augmenta sends a whole object's fields in a single message's
// argument list — so we upsert per object id and drop stale ids, closer to poseStore's wholesale
// model. The v1 `/au/person*` addresses are still emitted by v2 for backward compatibility; we
// accept both the `person` and `object` spellings, and enter/update/leave verbs, tolerantly.
//
//   /au/scene            args: [frame, objectCount, sceneWidth(m), sceneHeight(m), ...]
//   /au/personUpdated    args: [pid, oid, age, centroid.x, centroid.y, velocity.x, velocity.y,
//   /au/personEntered           depth, boundingRect.x, boundingRect.y, boundingRect.w,
//   (and /au/objectUpdate…)     boundingRect.h, highest.x, highest.y, highest.z]
//   /au/personWillLeave  args: [pid, ...]  → remove that id
//
// Centroid is normalized [0..1] with a TOP-LEFT origin (screen convention); we flip to the blob
// system's BOTTOM-LEFT origin (v = 1 − centroid.y) so the shared render math (motion / blobPass)
// applies unchanged. The exact wire schema is finalized on hardware via the Augmenta Monitor panel
// (the parser is deliberately positional + defensive so a field-order surprise degrades gracefully).

import type { OscMessage } from '@artlux/sdk/renderer';

// Unique module-identity marker: the barrel rule (see index.ts) requires this store to be a single
// instance per window bundle. `npm run verify:plugins` checks the '[augmenta] subscriber' log string
// below appears in exactly one renderer chunk — two copies mean host code deep-imported past the barrel.
export const AUGMENTA_STORE_MARKER = '__artlux_augmenta_store_v1__';

// One tracked Augmenta object (person/object) for the current frame. `id` is the Augmenta-assigned
// stable identity (unique per object lifetime) — the box does detection + association server-side, so
// downstream we only smooth, never re-associate.
export interface AugmentaObject {
  id: number;        // Augmenta pid — stable tracking id (0 is a valid id here, unlike LiDAR slots)
  oid: number;       // ordered id (0-based index among current objects)
  u: number;         // centroid x, normalized [0..1], origin left
  v: number;         // centroid y, normalized [0..1], origin BOTTOM (flipped from Augmenta's top-left)
  vx: number;        // native velocity x (normalized units/sec) — available; motion also derives its own
  vy: number;        // native velocity y
  width: number;     // bounding-box width, normalized [0..1]
  height: number;    // bounding-box height, normalized [0..1]
  age: number;       // frames the object has been tracked
  depth: number;     // distance to sensor (m), when provided
  updatedAt: number; // performance.now() of the last field update (for the stale-ghost filter)
}

// Scene-level frame info + the tracked field's real-world size (metres). Drives the source aspect and
// the 3D floor rectangle. Defaults to a 16:9-ish field until the first /au/scene arrives.
export interface AugmentaScene {
  frame: number;
  objectCount: number;
  sceneW: number;    // field width, metres (0 = unknown)
  sceneH: number;    // field depth, metres (0 = unknown)
}

// A flat, serializable copy of the active state — bridged from the OSC-receiving main window to
// projector output windows showing AUGMENTA content (which never see OSC directly).
export interface AugmentaSnapshot {
  scene: AugmentaScene;
  objects: AugmentaObject[];
}

const objects = new Map<number, AugmentaObject>();
let scene: AugmentaScene = { frame: 0, objectCount: 0, sceneW: 0, sceneH: 0 };
const subs = new Set<() => void>();

// Replay/simulation override (parity with the LiDAR/pose stores): while an external source drives the
// store (a future recorded take), live OSC ingest is swallowed so the recording stays authoritative.
let replaySource = false;
export function setReplaySource(on: boolean): void { replaySource = on; }
export function isReplaySource(): boolean { return replaySource; }

// Coalesce notifications to one per animation frame — an Augmenta frame lands as many OSC messages,
// but multiple consumers + the projector bridge subscribe, so batch their wakeups.
let dirty = false;
let rafId = 0;
function markDirty(): void {
  dirty = true;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!dirty) return;
    dirty = false;
    subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[augmenta] subscriber error', e); } });
  });
}

// Address grammar (case-insensitive, tolerant of the person/object spellings and the v1/v2 verbs).
const SCENE_RE = /^\/au\/scene\b/i;
const ENTER_RE = /^\/au\/(?:person|object)s?(?:_|\/)?(?:entered|enter|new)\b/i;
const UPDATE_RE = /^\/au\/(?:person|object)s?(?:_|\/)?(?:updated|update)\b/i;
const LEAVE_RE = /^\/au\/(?:person|object)s?(?:_|\/)?(?:willleave|will_leave|leave|left|lost)\b/i;

const num = (a: OscMessage['args'][number] | undefined): number => (typeof a === 'number' ? a : 0);

function getObject(id: number): AugmentaObject {
  let o = objects.get(id);
  if (!o) { o = { id, oid: 0, u: 0, v: 0, vx: 0, vy: 0, width: 0, height: 0, age: 0, depth: 0, updatedAt: 0 }; objects.set(id, o); }
  return o;
}

// Upsert one object from an enter/update message's positional argument list. Order follows the
// documented Augmenta OSC v2 person/object layout; missing trailing args just stay 0 (defensive).
function upsertFromArgs(args: OscMessage['args'], now: number): void {
  const id = num(args[0]);
  const o = getObject(id);
  o.oid = num(args[1]);
  o.age = num(args[2]);
  o.u = num(args[3]);
  o.v = 1 - num(args[4]);           // Augmenta top-left → blob-system bottom-left
  o.vx = num(args[5]);
  o.vy = -num(args[6]);             // velocity y flips with the origin flip
  o.depth = num(args[7]);
  o.width = num(args[10]);          // boundingRect.width (args 8/9 are the box x/y origin)
  o.height = num(args[11]);         // boundingRect.height
  o.updatedAt = now;
}

// Ingest one UDP packet's worth of decoded OSC messages. Returns the number of Augmenta messages it
// recognised (0 = nothing on the wire matched the Augmenta grammar — useful for a "seen any?" hint).
export function ingestBundle(msgs: OscMessage[]): number {
  if (replaySource) return 0; // a recorded take owns the store — ignore the live box
  const now = performance.now();
  let handled = 0;
  for (const m of msgs) {
    if (SCENE_RE.test(m.address)) {
      scene = {
        frame: num(m.args[0]),
        objectCount: num(m.args[1]),
        sceneW: num(m.args[2]) || scene.sceneW,
        sceneH: num(m.args[3]) || scene.sceneH,
      };
      handled++;
    } else if (UPDATE_RE.test(m.address) || ENTER_RE.test(m.address)) {
      upsertFromArgs(m.args, now);
      handled++;
    } else if (LEAVE_RE.test(m.address)) {
      objects.delete(num(m.args[0]));
      handled++;
    }
  }
  if (handled) markDirty();
  return handled;
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

// Ghost backstop: drop objects whose updates went silent (a leave message got lost). The Augmenta
// `personWillLeave` is the primary removal signal; this only catches a dropped packet.
const STALE_TTL_MS = 1000;

// Live objects (fresh within the TTL). The single source of truth for the renderer + 3D viz.
export function getObjects(): AugmentaObject[] {
  const now = performance.now();
  const out: AugmentaObject[] = [];
  for (const o of objects.values()) if (now - o.updatedAt <= STALE_TTL_MS) out.push(o);
  return out;
}

export function getScene(): AugmentaScene { return scene; }

// Serialize active state for bridging to projector windows.
export function snapshot(): AugmentaSnapshot {
  return { scene: { ...scene }, objects: getObjects().map((o) => ({ ...o })) };
}

// Replace the store from a bridged snapshot (projector window) or a replayed take. Stamp updatedAt=now
// so applied objects count as fresh for this window's own stale checks / smoother.
export function applySnapshot(snap: AugmentaSnapshot): void {
  const now = performance.now();
  scene = { ...snap.scene };
  objects.clear();
  for (const o of snap.objects) objects.set(o.id, { ...o, updatedAt: now });
  markDirty();
}
