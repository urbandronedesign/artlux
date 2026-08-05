import type { HapInfo, HapFrame } from './types';

// Renderer-side helper around the native HAP decoder (main process). Caches per-file stream
// info from a one-time probe, and runs a small per-file prefetch pipeline so playback paints
// from a ready buffer instead of stalling on each decode/IPC round-trip (which caused subtle
// frame drops). Used by both the timeline engine (layer clips) and surfaceMedia (surfaces).
// HAP is carried in QuickTime/MOV; only `.mov` is probed (the demux is ISO-BMFF, not RIFF).

export const isHapCandidate = (path: string): boolean => /\.mov$/i.test(path);

const infos = new Map<string, HapInfo | null>(); // resolved: HapInfo (is HAP) or null (not HAP)
const probing = new Set<string>();

// Probe + open a path. Resolves to its HapInfo, or null if it isn't HAP. Idempotent; the
// result is cached so later calls are synchronous via getInfo()/isHap().
export async function ensureOpen(path: string): Promise<HapInfo | null> {
  if (infos.has(path)) return infos.get(path)!;
  if (probing.has(path)) return null; // in flight — caller re-checks next frame
  if (typeof window === 'undefined' || !window.artlux?.pluginInvoke) return null;
  probing.add(path);
  try {
    const info = ((await window.artlux.pluginInvoke('hap:open', path)) as HapInfo | null) ?? null;
    infos.set(path, info);
    return info;
  } catch {
    infos.set(path, null);
    return null;
  } finally {
    probing.delete(path);
  }
}

// Synchronous: HapInfo if known-HAP, else null (not HAP or not yet probed).
export function getInfo(path: string): HapInfo | null {
  return infos.get(path) ?? null;
}

// true/false once probed; undefined while still probing (caller should wait, not decide).
export function isHap(path: string): boolean | undefined {
  if (!infos.has(path)) return undefined;
  return infos.get(path) !== null;
}

// --- Decode-ahead ring -----------------------------------------------------------------
// Keep the next ~LEAD_MS of frames decoded ahead of the playhead so the exact frame is almost
// always ready when the compositor asks for it — a stale/repeated frame is the visible glitch.
// Decodes run on the native side's libuv pool; we bound in-flight per source so several layers
// don't thrash it, while still holding a deeper buffer of *completed* frames than the old fixed
// count did. Each frame is small (raw BC blocks): ~1MB (1080p DXT1) … ~4MB (4K DXT5).
type Frame = HapFrame;
type Pipe = { cache: Map<number, Frame>; inflight: Set<number>; failed: Set<number> };
const pipes = new Map<string, Pipe>();
const LEAD_MS = 300;      // how far ahead of the playhead to keep decoded
const TRAIL_FRAMES = 2;   // a couple kept behind (loop wrap / tiny back-steps)
const MAX_INFLIGHT = 3;   // concurrent decodes per source (caps IPC + threadpool pressure)
// Distinct frames that may fail before we stop believing the file is playable at all. A real HAP
// stream is all-intra and self-contained, so one bad frame is a bad frame — three is a bad FILE.
const GIVE_UP_AFTER = 3;

function getPipe(path: string): Pipe {
  let p = pipes.get(path);
  if (!p) { p = { cache: new Map(), inflight: new Set(), failed: new Set() }; pipes.set(path, p); }
  return p;
}

// Roughly what this source's decode ring is holding, in bytes — for the host's residency budget
// (services/codecResidency), which evicts warm standby pools and cannot otherwise tell a pool of two
// 1080p layers from one of twenty 4K ones. Measured from the frames actually cached rather than from
// the format, because the ring's depth is what varies: LEAD_MS of a 60 fps source is ~18 frames, of a
// 24 fps source ~7. Under-reports whatever the GPU holds after upload — see the SDK's note.
export function residentBytes(path: string): number {
  const p = pipes.get(path);
  if (!p) return 0;
  let n = 0;
  for (const f of p.cache.values()) n += f.data?.byteLength ?? 0;
  return n;
}

// ⚠ A FAILED DECODE MUST BE REMEMBERED, OR IT BECOMES A FULL-SPEED RETRY LOOP.
// `fill()` runs from getFrame() on EVERY rAF. Nothing cached the failure, so a frame that could not be
// decoded was re-requested the very next frame — three concurrent decodes per frame, forever, each
// doing a real seek + read of a multi-MB sample in main before erroring, each logging. That is the
// shape of an undecodable variant (HAP Q Alpha / HapM, refused at open since — see native/hap), a
// truncated file, or a sample lost to a bad copy. The picture is black either way; the retry storm is
// what took the frame rate down with it.
function markFailed(path: string, p: Pipe, idx: number): void {
  p.failed.add(idx);
  if (p.failed.size < GIVE_UP_AFTER || infos.get(path) === null) return;
  // Enough distinct frames have failed that this is not a bad frame, it is a bad file. Publish it
  // through the SAME signal probe() uses — `infos[path] = null` makes isHap() false. A timeline LAYER
  // re-asks `probed()` every frame, so it falls through to syncVideoLayer immediately; a SURFACE was
  // classified at acquire time and stays black until the next open/acquire. Either way the requests
  // stop, which is the point. Said once per file, at error level: the output is black and the operator
  // needs to know why.
  infos.set(path, null);
  console.error(`[hap] giving up on ${path} — ${p.failed.size} frames failed to decode; the file is not playable as HAP`);
}

function request(path: string, idx: number): void {
  const info = infos.get(path);
  if (!info || idx < 0 || idx >= info.frameCount) return;
  const p = getPipe(path);
  if (p.cache.has(idx) || p.inflight.has(idx) || p.failed.has(idx)) return;
  p.inflight.add(idx);
  ((window.artlux?.pluginInvoke?.('hap:decode', path, idx) as Promise<HapFrame | null> | undefined) ?? Promise.resolve(null))
    .then((f) => {
      p.inflight.delete(idx);
      if (f) p.cache.set(idx, f);
      else markFailed(path, p, idx); // resolved null = the decoder is absent or refused this frame
    })
    .catch(() => { p.inflight.delete(idx); markFailed(path, p, idx); });
}

// Keep the ring filled around `idx`: evict frames outside the retain window (measured
// circularly so the loop-start frames stay pre-warmed), then issue the nearest-future-missing
// decodes first, bounded by the in-flight budget so we never flood the pool.
function fill(path: string, idx: number): void {
  const info = infos.get(path);
  if (!info || info.frameCount <= 0) return;
  const fc = info.frameCount;
  const ahead = Math.min(fc - 1, Math.max(2, Math.ceil((LEAD_MS / 1000) * info.fps)));
  const p = getPipe(path);

  // Retain [idx-TRAIL … idx+ahead] (circular); evict the rest.
  for (const k of [...p.cache.keys()]) {
    const fwd = ((k - idx) % fc + fc) % fc;          // frames ahead of the playhead (wraps)
    if (fwd > ahead && fwd < fc - TRAIL_FRAMES) p.cache.delete(k);
  }

  // Request missing frames ahead, nearest first, until the in-flight budget is spent.
  let slots = MAX_INFLIGHT - p.inflight.size;
  for (let d = 0; d <= ahead && slots > 0; d++) {
    const k = (idx + d) % fc;
    if (p.cache.has(k) || p.inflight.has(k) || p.failed.has(k)) continue; // `failed`: never re-ask
    request(path, k);
    slots--;
  }
}

// Top up the ring around the frame at `atSec` and report whether `aheadSec` of material is decoded.
// The cold-start gate (services/bootGate, via the codec's preRoll) polls this while it holds the show,
// so the POLLING is what primes the buffer — see the SDK's preRoll contract.
//
// A show used to start on an empty ring: the first seconds asked for frames nobody had decoded yet and
// the compositor painted the nearest neighbour instead — 167 misses in the first ten seconds of a
// 1080p60 HAP show, i.e. a visible stutter exactly when the audience is watching. `asked`/`missed`
// deliberately do NOT count these: nothing is on screen yet, so a pre-roll miss is not a dropped frame.
export function preRoll(path: string, atSec: number, aheadSec: number): boolean {
  const info = infos.get(path);
  if (info === null) return true;            // probed and it is not HAP — nothing here to wait for
  if (!info || info.frameCount <= 0) { void ensureOpen(path); return false; } // not probed yet
  const start = Math.max(0, Math.min(Math.round(atSec * info.fps), info.frameCount - 1));
  const want = Math.max(1, Math.min(Math.ceil(aheadSec * info.fps), info.frameCount));
  fill(path, start);                          // issue the decodes (bounded by MAX_INFLIGHT)
  const p = getPipe(path);
  let have = 0;
  for (let d = 0; d < want; d++) {
    const k = (start + d) % info.frameCount;
    if (p.cache.has(k)) have++;
    else if (p.failed.has(k)) have++;         // this frame will never arrive; don't hold the show for it
  }
  return have >= want;
}

// --- Ring health (diagnostics) ---------------------------------------------------------------
// THE signal for "is decode+IPC keeping up with N simultaneous sources". A miss means the exact
// frame for this playhead wasn't decoded in time and we painted a neighbour instead — i.e. the
// source visibly stuttered. Bandwidth numbers are a proxy; this is the symptom itself.
// Read via window.__artluxHapStats() while a show runs; costs two integer adds per frame.
const stats = { asked: 0, missed: 0 };
export function getStats(): { asked: number; missed: number; missRate: number } {
  return { ...stats, missRate: stats.asked ? stats.missed / stats.asked : 0 };
}
export function resetStats(): void { stats.asked = 0; stats.missed = 0; }
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>)['__artluxHapStats'] = getStats;
  (window as unknown as Record<string, unknown>)['__artluxHapStatsReset'] = resetStats;
}

// Best decoded frame to show for playhead `idx`, plus ring upkeep. Returns the exact frame if
// ready, else the nearest decoded frame at/just-before it (or just-after) — this keeps the
// canvas updating continuously instead of only when the exact frame happens to be cached.
export function getFrame(path: string, idx: number): { index: number; frame: Frame } | null {
  fill(path, idx);
  const cache = getPipe(path).cache;
  stats.asked++;
  const exact = cache.get(idx);
  if (exact) return { index: idx, frame: exact };
  stats.missed++; // ring underrun — the exact frame wasn't ready
  let below = -1, above = Infinity;
  for (const k of cache.keys()) {
    if (k <= idx) { if (k > below) below = k; }
    else if (k < above) above = k;
  }
  const pick = below >= 0 ? below : (Number.isFinite(above) ? above : -1);
  return pick >= 0 ? { index: pick, frame: cache.get(pick)! } : null;
}

export function release(path: string): void {
  infos.delete(path);
  probing.delete(path);
  pipes.delete(path);
  window.artlux?.pluginSend?.('hap:close', path);
}

// One-shot decode that bypasses the playback prefetch ring entirely. Used by the thumbnail
// cache so scrubbing for thumbnails never re-centers a layer's live decode-ahead window (which
// would starve playback). Returns null if the native decoder is unavailable.
export async function decodeFrameRaw(path: string, idx: number): Promise<HapFrame | null> {
  try {
    return ((await window.artlux?.pluginInvoke?.('hap:decode', path, idx)) as HapFrame | null) ?? null;
  } catch {
    return null;
  }
}
