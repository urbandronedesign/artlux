// ONE REFCOUNT FOR EVERY CODEC DECODER — and the release path a warm pool never had.
//
// A plugin VideoCodec keys its surface decoder by PATH, not by consumer: hap's `open$` and mp4's
// `decoders` both hand the SAME decoder to everyone asking for the same file. That sharing is the
// point — it is why N surfaces on one clip cost one decode. But `closeSurface(path)` tears that
// shared decoder down unconditionally, so it can only be called when the LAST holder lets go, and
// something has to count holders.
//
// TWO THINGS COUNTED, AND ONLY ONE OF THEM RELEASED. contentSource counted SURFACE consumers (and
// still does the work correctly for them — that logic moved here verbatim). Nothing counted the
// decoders `timeline.warmMedia` opens when it warms a pool: `preWarm(path)` opens a path-keyed
// decoder, and `releasePool` freed the pool's <video>s and its LAYER-keyed codec state while the
// path-keyed decoder it had opened stayed resident. So a pool demoted to COLD was not cold. For mp4
// that decoder holds every compressed sample of the track; for HAP, a ring of decoded 1–4 MB frames.
// A show visiting thirty states over an evening accumulated all of them, and the residency tiers
// documented in docs/SCENE-TIMELINES.md described something the code did not do.
//
// Hence one module, one vocabulary: an OWNER retains a path, and the decoder closes when the last
// owner releases it. Owners are surface/consumer keys (from contentSource) and pool keys (from the
// timeline engine) in the same namespace — they never collide, and more importantly they now can't
// disagree. Two independent refcounts over one shared resource is exactly how the gap survived.

import { videoCodecRegistry } from '../host/registries';

// path -> the owners holding it open. An owner is a contentSource consumer key (surface id,
// `layer:<id>`) or a timeline pool key (scene id, GLOBAL_POOL).
const users = new Map<string, Set<string>>();
// path -> the codec that opened it, so release doesn't need the caller to remember.
const codecOf = new Map<string, string>();

export function retain(path: string, owner: string, codecId: string): void {
  if (!path || !owner) return;
  let set = users.get(path);
  if (!set) { set = new Set(); users.set(path, set); }
  set.add(owner);
  codecOf.set(path, codecId);
}

/**
 * Drop `owner`'s claim on `path`; closes the shared decoder only when nobody is left.
 *
 * `codecId` is optional — callers that know it (contentSource, which stored it on the entry) pass it;
 * callers that only know the path (a pool release) let the map answer. Passing a codecId for a path
 * this module never saw still closes it, which keeps the old contentSource behaviour exactly.
 */
export function release(path: string, owner: string, codecId?: string): void {
  if (!path || !owner) return;
  const set = users.get(path);
  if (set) {
    set.delete(owner);
    if (set.size > 0) return; // another surface, clip or warm pool still holds this file open
    users.delete(path);
  }
  const id = codecId ?? codecOf.get(path);
  codecOf.delete(path);
  if (id) videoCodecRegistry.get(id)?.closeSurface(path);
}

/** Drop every claim `owner` holds, closing whatever that leaves unheld. Used when a pool is demoted. */
export function releaseOwner(owner: string): void {
  if (!owner) return;
  // Snapshot: release() mutates `users` as it goes.
  for (const path of [...users.keys()]) {
    if (users.get(path)?.has(owner)) release(path, owner);
  }
}

/**
 * Best-effort resident bytes across every open decoder, for the residency budget.
 *
 * BEST-EFFORT IS NOT A HEDGE, IT IS THE CONTRACT: a codec reports what it can account for
 * (mp4's compressed samples, HAP's frame ring) and cannot see GPU-side VideoFrames or driver
 * allocations, so this UNDER-reports. A budget that admits its precision is usable; one that pretends
 * to exactness would have someone size a venue machine by it.
 */
export function bytes(): number {
  let total = 0;
  for (const [path, id] of codecOf) {
    const codec = videoCodecRegistry.get(id);
    total += codec?.residentBytes?.(path) ?? 0;
  }
  return total;
}

/** Open decoder count — the honest fallback when no codec implements residentBytes. */
export const openCount = (): number => codecOf.size;

/** Diagnostics for the bench + the console: which paths are held, and by whom. */
export function snapshot(): { path: string; codecId: string; owners: string[]; bytes: number }[] {
  return [...users.entries()].map(([path, set]) => {
    const id = codecOf.get(path) ?? '';
    return { path, codecId: id, owners: [...set], bytes: videoCodecRegistry.get(id)?.residentBytes?.(path) ?? 0 };
  });
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__artluxCodecResidency'] = snapshot;
}
