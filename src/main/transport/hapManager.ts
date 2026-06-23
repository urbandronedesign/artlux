import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HapInfo, HapFrame } from '../../../shared/protocol';

// Loads the native HAP decoder (native/hap/hap.node) in the main process — the sandboxed
// renderer can't require a .node, so it pulls decoded RGBA frames by index via IPC. HAP
// decode is CPU/SIMD (Snappy + BC block decode), so there's no hardware video-decode session:
// the main process can decode many HAP sources at once without the H.264 session limit. HAP
// is all-intra, so any frame decodes independently — the renderer requests the exact frame for
// the current playhead (good for both playback and scrubbing).

interface HapNative {
  open(path: string): HapInfo;
  decodeFrameBlocks(path: string, index: number): Promise<HapFrame>; // async (libuv threadpool)
  close(path: string): void;
}

const req = createRequire(__filename);

function loadNative(): HapNative | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'hap.node'), // packaged
    join(process.cwd(), 'native/hap/hap.node'),
    join(__dirname, '../../native/hap/hap.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as HapNative;
    } catch (e) {
      console.warn('[hap] native decoder load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[hap] native decoder loaded' : '[hap] native decoder unavailable');

const open$ = new Map<string, HapInfo>();

// Open a HAP source; returns its info, or null if the file isn't HAP (caller falls back to
// the browser <video>) or the addon is missing.
export function open(path: string): HapInfo | null {
  if (!native) return null;
  const cached = open$.get(path);
  if (cached) return cached;
  try {
    const info = native.open(path);
    open$.set(path, info);
    console.log(`[hap] opened ${path} — ${info.width}x${info.height} ${info.codec} ${info.frameCount}f @${info.fps.toFixed(2)}fps`);
    return info;
  } catch (e) {
    console.log(`[hap] not HAP / open failed (${path}):`, (e as Error)?.message ?? e);
    return null;
  }
}

export async function decode(path: string, index: number): Promise<HapFrame | null> {
  if (!native) return null;
  if (!open$.has(path) && !open(path)) return null;
  try {
    return await native.decodeFrameBlocks(path, index);
  } catch (e) {
    console.warn(`[hap] decode frame ${index} failed:`, (e as Error)?.message ?? e);
    return null;
  }
}

export function close(path: string): void {
  if (!open$.has(path)) return;
  open$.delete(path);
  try {
    native?.close(path);
  } catch { /* ignore */ }
}

export function closeAll(): void {
  for (const path of [...open$.keys()]) close(path);
}
