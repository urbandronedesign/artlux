// Recorded LiDAR-blob "take": a time-stamped sequence of tracking snapshots, stored as a sidecar
// `.lblob` JSON file and replayed into the tracking store during timeline playback (trackingPlayback).
// A take captures exactly what `trackingStore.snapshot()` produces each frame, so replay is a
// byte-faithful round-trip of the live feed (the scene applies its own smoothing on top).
import type { TrackingSnapshot } from './trackingStore';

export interface TrackingTakeFrame {
  t: number;             // seconds from the start of the take
  snap: TrackingSnapshot;
}
export interface TrackingTake {
  version: 1;
  id: string;
  name: string;
  duration: number;      // seconds (t of the last frame)
  fps?: number;          // nominal capture rate
  frames: TrackingTakeFrame[]; // monotonic by t
  density?: number[];    // per-bin active-blob count, for the lane sparkline
}

const EMPTY: TrackingSnapshot = { surfaces: [] };

// Per-bin peak active-blob count across the take — a cheap visual signature for the clip sparkline.
export function buildDensity(frames: TrackingTakeFrame[], bins = 160): number[] {
  const out = new Array(bins).fill(0);
  const dur = frames.length ? frames[frames.length - 1].t : 0;
  if (dur <= 0) return out;
  for (const f of frames) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((f.t / dur) * bins)));
    let n = 0;
    for (const s of f.snap.surfaces) n += s.blobs.length;
    if (n > out[i]) out[i] = n;
  }
  return out;
}

export function serialize(take: TrackingTake): string {
  return JSON.stringify(take);
}

export function parse(bytes: Uint8Array): TrackingTake | null {
  try {
    const take = JSON.parse(new TextDecoder().decode(bytes)) as TrackingTake;
    if (!take || !Array.isArray(take.frames)) return null;
    return take;
  } catch (e) {
    console.error('[trackingTake] parse failed', e);
    return null;
  }
}

// The snapshot to show at local time `local` (seconds into the take): the last frame whose t ≤ local
// (step lookup — blob updates are discrete events, no tween). Before the first frame ⇒ empty.
export function frameAt(take: TrackingTake, local: number): TrackingSnapshot {
  const f = take.frames;
  if (f.length === 0 || local < f[0].t) return EMPTY;
  if (local >= f[f.length - 1].t) return f[f.length - 1].snap;
  let lo = 0, hi = f.length - 1; // greatest index with f[i].t ≤ local
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (f[mid].t <= local) lo = mid; else hi = mid - 1;
  }
  return f[lo].snap;
}

// ---- Load + cache (keyed by sidecar path) -----------------------------------
const cache = new Map<string, TrackingTake>();
const loading = new Set<string>();

export function getCached(path: string): TrackingTake | undefined { return cache.get(path); }
export function putCache(path: string, take: TrackingTake): void { cache.set(path, take); }

// Lazily read + cache a take's sidecar file. Returns null until the bytes are in (call again).
export async function ensureLoaded(path: string): Promise<TrackingTake | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  if (loading.has(path)) return null;
  loading.add(path);
  try {
    const bytes = await window.artlux?.readFile?.(path);
    if (!bytes) return null;
    const take = parse(bytes);
    if (take) cache.set(path, take);
    return take;
  } finally {
    loading.delete(path);
  }
}
