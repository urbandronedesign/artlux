// Intelligent preloader for per-scene decoupled timelines. Because exactly ONE timeline is live at a
// time (see services/timeline.ts), every other state should hold as few live decode resources as
// possible. This module manages a tiered residency model — a small sliding window of WARM standby
// pools that follows the show's path — so a GO/transition into a likely-next state is hitless at
// 60fps while unlikely states cost nothing.
//
//   ACTIVE  (1)          playing              — the engine's active pool
//   WARM    (<= MAX_WARM) paused, pre-seeked   — decoders held, ~0 CPU, ready for an instant swap
//   COLD    (rest)        torn down            — no decoders, only shared path-keyed blobs remain
//
// Warming is all async IPC + createObjectURL + decode-init — off the rAF/compute path, so the frame
// loop is never blocked. mediaCache blobs and codec preWarm are path-keyed and globally shared, so
// warming shared media across states is ~free; only the per-layer <video> pool is per-scene.

import { timeline as engine, GLOBAL_POOL } from './timeline';
import type { Timeline } from '../types';

// Standby budget (excludes the always-live ACTIVE pool and the shared GLOBAL fallback). Bounded by
// concurrent hardware-decode sessions — each warm <video> per layer holds one decoder. Kept small;
// callers can pass fewer look-ahead scenes when they're video-heavy.
const MAX_WARM = 2;

// Pool keys in least-recently-touched order (index 0 = oldest). Bookkeeping for LRU eviction.
const lru: string[] = [];

function touch(key: string): void {
  const i = lru.indexOf(key);
  if (i >= 0) lru.splice(i, 1);
  lru.push(key);
}

// Warm one scene's timeline into a standby pool, then trim back to budget (protecting it + the active).
export function warm(poolKey: string, tl: Timeline | undefined): void {
  if (!tl) return;
  engine.warmPool(poolKey, tl);
  touch(poolKey);
  evictExcess([poolKey]);
}

// Warm a set of look-ahead scenes (FSM reachable-next states, or Scenes-panel hover/adjacent cells),
// then trim to budget protecting exactly this set — so the warm window tracks the show's path.
export function predict(entries: { key: string; tl: Timeline | undefined }[]): void {
  for (const e of entries) {
    if (!e.tl) continue;
    engine.warmPool(e.key, e.tl);
    touch(e.key);
  }
  evictExcess(entries.map(e => e.key));
}

// Demote least-recently-used standby pools to COLD until at most MAX_WARM remain. Never touches the
// ACTIVE pool, the GLOBAL fallback, or any explicitly-protected key.
export function evictExcess(protect: string[] = []): void {
  const keep = new Set<string>([GLOBAL_POOL, engine.activePoolKey(), ...protect]);
  const held = engine.warmPoolKeys();
  // Standby pools in LRU order (oldest first), limited to ones the engine still holds.
  const standby = lru.filter(k => held.includes(k) && !keep.has(k));
  const excess = standby.length - MAX_WARM;
  for (let i = 0; i < excess; i++) {
    engine.releasePool(standby[i]);
    const li = lru.indexOf(standby[i]);
    if (li >= 0) lru.splice(li, 1);
  }
  // Drop bookkeeping for pools the engine no longer holds (e.g. released elsewhere).
  for (let i = lru.length - 1; i >= 0; i--) if (!held.includes(lru[i])) lru.splice(i, 1);
}
