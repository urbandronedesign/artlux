import type { HapInfo, HapFrame } from '../../../shared/protocol';

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
  if (typeof window === 'undefined' || !window.artlux?.openHap) return null;
  probing.add(path);
  try {
    const info = (await window.artlux.openHap(path)) ?? null;
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

// --- Prefetch pipeline ----------------------------------------------------------------
// A few decoded frames kept ahead of the playhead per file. Decodes run concurrently (the
// native side serializes them) so the IPC round-trips pipeline instead of blocking paint.
type Frame = HapFrame;
type Pipe = { cache: Map<number, Frame>; inflight: Set<number>; order: number[] };
const pipes = new Map<string, Pipe>();
const CACHE_FRAMES = 4;   // decoded frames retained per file (small — each 1080p frame is 8MB)
const PREFETCH_AHEAD = 2; // frames ahead — keep low; deep prefetch floods IPC with 8MB frames

function getPipe(path: string): Pipe {
  let p = pipes.get(path);
  if (!p) { p = { cache: new Map(), inflight: new Set(), order: [] }; pipes.set(path, p); }
  return p;
}

function request(path: string, idx: number): void {
  const info = infos.get(path);
  if (!info || idx < 0 || idx >= info.frameCount) return;
  const p = getPipe(path);
  if (p.cache.has(idx) || p.inflight.has(idx)) return;
  p.inflight.add(idx);
  (window.artlux?.decodeHapFrame?.(path, idx) ?? Promise.resolve(null))
    .then((f) => {
      p.inflight.delete(idx);
      if (!f) return;
      p.cache.set(idx, f);
      p.order.push(idx);
      while (p.order.length > CACHE_FRAMES) {
        const old = p.order.shift()!;
        if (!p.order.includes(old)) p.cache.delete(old);
      }
    })
    .catch(() => { p.inflight.delete(idx); });
}

// Best decoded frame to show for playhead `idx`, with its actual index, plus prefetch of the
// next frames. Decodes complete a little behind the playhead, so we return the exact frame if
// ready, else the nearest decoded frame at/just-before it (or just-after) — this keeps the
// canvas updating continuously instead of only when the exact frame happens to be cached.
export function getFrame(path: string, idx: number): { index: number; frame: Frame } | null {
  request(path, idx);
  for (let k = 1; k <= PREFETCH_AHEAD; k++) request(path, idx + k);
  const cache = getPipe(path).cache;
  const exact = cache.get(idx);
  if (exact) return { index: idx, frame: exact };
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
  window.artlux?.closeHap?.(path);
}
