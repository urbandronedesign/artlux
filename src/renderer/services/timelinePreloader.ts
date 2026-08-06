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
import * as codecResidency from './codecResidency';
import type { Timeline } from '../types';

// Standby budget (excludes the always-live ACTIVE pool and the shared GLOBAL fallback). Bounded by
// concurrent hardware-decode sessions — each warm <video> per layer holds one decoder. Kept small;
// callers can pass fewer look-ahead scenes when they're video-heavy.
// Exported so a caller can TRIM its look-ahead to the budget instead of handing in more keys than the
// budget allows and relying on this module to sort it out (it cannot — see evictExcess).
export const MAX_WARM = 2;

// The other half of the budget: bytes held by open codec decoders across every warm pool. A count of
// pools cannot express what a pool costs, and the pathological case is real — a standby pool of 4K
// HAP layers holds a decode ring of ~4 MB per frame per layer, while a pool of 720p <video>s holds
// almost nothing. Generous on purpose: this is a backstop against a show that would otherwise page,
// not an allocator, and evicting a pool the show is about to enter is worse than holding it.
// 0 disables the ceiling. (Wired to a preference in a later phase — see the plan.)
let MAX_RESIDENT_BYTES = 1500 * 1048576;

export function setResidencyBudgetMB(mb: number): void {
  MAX_RESIDENT_BYTES = Number.isFinite(mb) && mb > 0 ? mb * 1048576 : 0;
}

// Pool keys in least-recently-touched order (index 0 = oldest). Bookkeeping for LRU eviction.
const lru: string[] = [];

// Residency, as the app actually holds it — for scripts/bench-warm.cjs and for anyone asking "why is
// this show using that much memory". Pool COUNT is the claim this module makes; bytes is what the
// claim is for. Same window-guarded diagnostic pattern as openTrace and __artluxHapStats.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__artluxWarmPools'] = () => ({
    active: engine.activePoolKey(),
    held: engine.warmPoolKeys(),
    lru: [...lru],
    maxWarm: MAX_WARM,
    codecBytes: codecResidency.bytes(),
    openDecoders: codecResidency.openCount(),
  });
}

// ── OTHER SUBSYSTEMS RIDE THE SAME WINDOW ────────────────────────────────────────────────────────
// A scene's pictures are not the only thing worth keeping ready for a cut the show might take. The
// audio plugin registers here so a WARM scene's sound stays engine-resident: without it, leaving a
// scene unloaded its clips and re-entering decoded them again, so a clip starting at 0 lost its first
// milliseconds — a percussive sting's whole attack — on every single entry.
//
// It has to be here rather than in the plugin because "which scenes are warm" is a decision only this
// module can make (it follows the machine's shape), and core must not import a plugin to tell it.
// Participants are driven wherever pools are: warm(), predict() and evictExcess().
interface WarmParticipant { warm(poolKey: string, timeline: Timeline): void; release(poolKey: string): void }
const participants = new Set<WarmParticipant>();

export function registerParticipant(p: WarmParticipant): () => void {
  participants.add(p);
  return () => { participants.delete(p); };
}

// A participant that throws must not break residency for everything else — the same discipline the
// boot gate applies to a probe.
const tellWarm = (key: string, tl: Timeline): void => {
  for (const p of participants) { try { p.warm(key, tl); } catch (e) { console.warn('[preload] participant warm threw', e); } }
};
const tellRelease = (key: string): void => {
  for (const p of participants) { try { p.release(key); } catch (e) { console.warn('[preload] participant release threw', e); } }
};

function touch(key: string): void {
  const i = lru.indexOf(key);
  if (i >= 0) lru.splice(i, 1);
  lru.push(key);
}

// Warm one scene's timeline into a standby pool, then trim back to budget (protecting it + the active).
export function warm(poolKey: string, tl: Timeline | undefined): void {
  if (!tl) return;
  engine.warmPool(poolKey, tl);
  tellWarm(poolKey, tl);
  touch(poolKey);
  evictExcess([poolKey]);
}

// Warm a set of look-ahead scenes (FSM reachable-next states, or Scenes-panel hover/adjacent cells),
// then trim to budget protecting exactly this set — so the warm window tracks the show's path.
export function predict(entries: { key: string; tl: Timeline | undefined }[]): void {
  for (const e of entries) {
    if (!e.tl) continue;
    engine.warmPool(e.key, e.tl);
    tellWarm(e.key, e.tl);
    touch(e.key);
  }
  evictExcess(entries.map(e => e.key));
}

// Demote least-recently-used standby pools to COLD until at most MAX_WARM remain. Never touches the
// ACTIVE pool or the GLOBAL fallback.
//
// ⚠ PROTECTED POOLS COUNT AGAINST THE BUDGET — they are not exempt from it, and that distinction is
// the whole point of this function. It used to subtract `protect` from `standby` BEFORE comparing to
// MAX_WARM, which made the budget unenforceable by the one caller that matters: the FSM look-ahead
// hands in every reachable-next state, so a hub state with ten outgoing transitions protected ten
// pools, `standby` came out empty, and `excess` was negative. Ten warm pools — ten sets of per-layer
// <video> decoders and ten warmed clip sets — against a budget of two, silently, for as long as the
// show sat on that state. Counting them in means an over-budget protect set evicts all UNPROTECTED
// standby (which is the most it can do without evicting something a caller just asked for), and the
// real fix pairs with it: callers rank and TRIM their look-ahead to MAX_WARM before calling here
// (see smLookahead.reachableNext), so the protect set is never over budget in the first place.
export function evictExcess(protect: string[] = []): void {
  const keep = new Set<string>([GLOBAL_POOL, engine.activePoolKey(), ...protect]);
  const held = engine.warmPoolKeys();
  // Standby pools in LRU order (oldest first), limited to ones the engine still holds.
  const standby = lru.filter(k => held.includes(k) && !keep.has(k));
  // Protected pools the engine actually holds occupy budget too. (Count from `held`, not from
  // `protect`: a key that was requested but never warmed holds no decoders and must not evict a pool
  // that does.)
  const protectedHeld = protect.filter(k => held.includes(k) && k !== GLOBAL_POOL && k !== engine.activePoolKey()).length;
  // Bounded by what there is to evict: an over-budget protect set makes `excess` exceed `standby`,
  // and walking past the end would call releasePool(undefined) — which the engine ignores, but the
  // lru bookkeeping below would not. Evicting every unprotected standby is the most this can do.
  let excess = Math.min(standby.length, standby.length + protectedHeld - MAX_WARM);
  for (let i = 0; i < excess; i++) {
    engine.releasePool(standby[i]);
    tellRelease(standby[i]);
    const li = lru.indexOf(standby[i]);
    if (li >= 0) lru.splice(li, 1);
  }
  // ── AND A BYTE CEILING, because counting pools says nothing about what a pool COSTS. Two standby
  // pools can be two 720p <video>s or twenty 4K HAP layers whose rings hold 4 MB a frame; the count
  // is identical and the memory differs by two orders of magnitude. Codecs report what they can
  // account for (VideoCodecContribution.residentBytes — best-effort, and it under-reports GPU-side
  // frames), so this is a backstop against the pathological case, not a precise allocator. Evict the
  // oldest remaining standby until the number comes down or there is nothing left to give.
  if (MAX_RESIDENT_BYTES > 0) {
    let guard = standby.length; // never loop longer than there are candidates
    while (codecResidency.bytes() > MAX_RESIDENT_BYTES && guard-- > 0) {
      const next = lru.find(k => engine.warmPoolKeys().includes(k) && !keep.has(k));
      if (!next) break; // everything left is active, global or protected — the budget cannot be met
      engine.releasePool(next);
      tellRelease(next);
      const li = lru.indexOf(next);
      if (li >= 0) lru.splice(li, 1);
      excess++;
    }
  }
  // Drop bookkeeping for pools the engine no longer holds (e.g. released elsewhere).
  for (let i = lru.length - 1; i >= 0; i--) if (!held.includes(lru[i])) lru.splice(i, 1);
}
