// LiDAR blob tracking store — the renderer-side sink for the 61fps tracking system's OSC data.
// Singleton pub/sub like dmxSignal: render-free, so high-rate blob updates never trigger React
// re-renders. Consumers (interactive effects, debug overlays) subscribe and read the snapshot.
//
// Protocol (one value per OSC message, accumulated per surface + slot):
//   /<surface>/specs/Scalex                 float  zone width  (meters)
//   /<surface>/specs/Scaley                 float  zone height (meters)
//   /<surface>/blobs/blob<n>/{id,tx,ty,u,v}
// where <surface> ∈ SOL (floor) | MUR (wall) | SOL_MUR (combined), <n> = slot index from 0.
// id == 0 means the slot is empty. u/v are normalized [0..1] with origin BOTTOM-LEFT (Y up);
// tx/ty are meters about the zone CENTER. See docs / plan for the full spec.

export interface Blob {
  slot: number;   // blob<n> slot index from the address
  id: number;     // live tracking id; 0 = inactive slot
  tx: number;     // world x, meters, origin = zone center
  ty: number;     // world y, meters, origin = zone center
  u: number;      // normalized x [0..1], origin bottom-left
  v: number;      // normalized y [0..1], origin bottom-left (Y up)
  updatedAt: number; // performance.now() of the last field update
}

export interface SurfaceTrack {
  surface: string;          // SOL | MUR | SOL_MUR | …
  scaleX: number;           // zone width in meters (from specs/Scalex)
  scaleY: number;           // zone height in meters (from specs/Scaley)
  blobs: Map<number, Blob>; // keyed by slot index
}

// A flat, serializable copy of the active tracking state — bridged from the OSC-receiving main
// window to the 3D Scene window (which never sees OSC directly). See scene/bridge.ts.
export interface TrackingSnapshot {
  surfaces: { surface: string; scaleX: number; scaleY: number; blobs: Blob[] }[];
}

const surfaces = new Map<string, SurfaceTrack>();
const subs = new Set<() => void>();

// Replay/simulation override: while a recorded take is driving the store (trackingPlayback),
// live OSC blob/spec messages are swallowed so the recording is authoritative. When no take is
// playing this is false and the live tracker flows through normally.
let replaySource = false;
export function setReplaySource(on: boolean): void { replaySource = on; }
export function isReplaySource(): boolean { return replaySource; }

// Coalesce notifications to one per animation frame — a tracking frame is many leaf messages.
let dirty = false;
let rafId = 0;
function markDirty(): void {
  dirty = true;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!dirty) return;
    dirty = false;
    subs.forEach((cb) => { try { cb(); } catch (e) { console.error('[tracking] subscriber error', e); } });
  });
}

function getSurface(name: string): SurfaceTrack {
  let s = surfaces.get(name);
  if (!s) { s = { surface: name, scaleX: 0, scaleY: 0, blobs: new Map() }; surfaces.set(name, s); }
  return s;
}

function getBlob(s: SurfaceTrack, slot: number): Blob {
  let b = s.blobs.get(slot);
  if (!b) { b = { slot, id: 0, tx: 0, ty: 0, u: 0, v: 0, updatedAt: 0 }; s.blobs.set(slot, b); }
  return b;
}

const SPEC_RE = /^\/([^/]+)\/specs\/(Scalex|Scaley)$/i;
const BLOB_RE = /^\/([^/]+)\/blobs\/blob(\d+)\/(id|tx|ty|u|v)$/i;

// Returns true if the address belonged to the tracking protocol (so the router can stop here).
export function ingest(address: string, value: number): boolean {
  const spec = SPEC_RE.exec(address);
  if (spec) {
    if (replaySource) return true; // a recorded take owns the store — ignore the live tracker
    const s = getSurface(spec[1]);
    if (spec[2].toLowerCase() === 'scalex') s.scaleX = value; else s.scaleY = value;
    markDirty();
    return true;
  }
  const m = BLOB_RE.exec(address);
  if (m) {
    if (replaySource) return true; // a recorded take owns the store — ignore the live tracker
    const s = getSurface(m[1]);
    const b = getBlob(s, parseInt(m[2], 10));
    const field = m[3].toLowerCase() as 'id' | 'tx' | 'ty' | 'u' | 'v';
    b[field] = value;
    b.updatedAt = performance.now();
    markDirty();
    return true;
  }
  return false;
}

export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

// Active blobs (id !== 0) for one surface, or all surfaces when omitted.
export function getActiveBlobs(surface?: string): Blob[] {
  const out: Blob[] = [];
  for (const s of surfaces.values()) {
    if (surface && s.surface !== surface) continue;
    for (const b of s.blobs.values()) if (b.id !== 0) out.push(b);
  }
  return out;
}

// Active blobs tagged with their surface — for the 3D viz, which maps each onto its zone.
export function getActiveEntries(): { surface: string; blob: Blob }[] {
  const out: { surface: string; blob: Blob }[] = [];
  for (const s of surfaces.values()) {
    for (const b of s.blobs.values()) if (b.id !== 0) out.push({ surface: s.surface, blob: b });
  }
  return out;
}

// Ghost backstop: drop active blobs whose updates went silent (a slot dropped without an id=0).
// id==0 stays the primary leave signal; this only catches a misbehaving sender. Applied in the
// main window's snapshot(), where performance.now() shares the clock that stamped updatedAt.
const STALE_TTL_MS = 1200;

// Serialize active state for bridging to the Scene window.
export function snapshot(): TrackingSnapshot {
  const now = performance.now();
  const out: TrackingSnapshot['surfaces'] = [];
  for (const s of surfaces.values()) {
    const blobs: Blob[] = [];
    for (const b of s.blobs.values()) if (b.id !== 0 && now - b.updatedAt <= STALE_TTL_MS) blobs.push({ ...b });
    if (blobs.length || s.scaleX || s.scaleY) out.push({ surface: s.surface, scaleX: s.scaleX, scaleY: s.scaleY, blobs });
  }
  return { surfaces: out };
}

// Replace the store from a bridged snapshot (Scene window). Notifies subscribers.
export function applySnapshot(snap: TrackingSnapshot): void {
  surfaces.clear();
  for (const su of snap.surfaces) {
    const t: SurfaceTrack = { surface: su.surface, scaleX: su.scaleX, scaleY: su.scaleY, blobs: new Map() };
    for (const b of su.blobs) t.blobs.set(b.slot, b);
    surfaces.set(su.surface, t);
  }
  markDirty();
}

export function getSurfaceTrack(surface: string): SurfaceTrack | undefined {
  return surfaces.get(surface);
}

export function getSurfaces(): string[] {
  return [...surfaces.keys()];
}

// Normalized blob position in SCREEN space (top-left origin, Y down) — flips the bottom-left v.
export function screenUV(b: Blob): [number, number] {
  return [b.u, 1 - b.v];
}
