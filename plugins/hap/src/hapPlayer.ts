import * as hapDecode from './hapDecode';
import * as hapGL from './hapGL';

// Surface-side HAP playback (for VIDEO surfaces whose file is HAP). Each active source loops
// off a shared play clock; every frame we pull the current frame index from the native decoder
// (hapDecode) and paint it onto a canvas that the surface compositor draws like Spout/NDI.
// Timeline LAYER clips use a separate, playhead-driven path in services/timeline.ts.

type Src = { canvas: HTMLCanvasElement | null; index: number };

const active = new Map<string, Src>();
let playing = true;
let clock = 0;          // seconds of playback elapsed (advances only while playing)
let clockOriginMs = 0;  // performance.now() (ms) at clock==0 — monotonic, drift-free
let raf = 0;

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  // Derive the clock from a fixed origin (not += dt) so it never accumulates rAF jitter/drift —
  // the source-frame cadence then stays uniform against the display refresh.
  if (playing) clock = (now - clockOriginMs) / 1000;
  for (const [path, s] of active) {
    const info = hapDecode.getInfo(path);
    if (!info || info.frameCount <= 0) continue;
    // round (not floor) centres the sampling phase: the average display error drops from a whole
    // source frame to half a frame, which is what removes the visible beat/judder.
    const idx = ((Math.round(clock * info.fps) % info.frameCount) + info.frameCount) % info.frameCount;
    const got = hapDecode.getFrame(path, idx); // decode-ahead ring hides decode/IPC latency
    if (got && got.index !== s.index) { s.canvas = hapGL.uploadFrame(path, got.frame); s.index = got.index; } // GPU decompress
  }
}

function ensureRaf(): void {
  if (!raf) { clockOriginMs = performance.now() - clock * 1000; raf = requestAnimationFrame(tick); }
}

// Probe + register a path. Resolves true if HAP (decoded here), false if not (caller falls
// back to a normal <video>). Idempotent.
export async function open(path: string): Promise<boolean> {
  const info = await hapDecode.ensureOpen(path);
  if (!info) return false;
  if (!active.has(path)) {
    active.set(path, { canvas: null, index: -1 });
    ensureRaf();
  }
  return true;
}

export function close(path: string): void {
  active.delete(path);
  hapGL.release(path);
  hapDecode.release(path);
}

export function setPlaying(p: boolean): void {
  if (p === playing) return;
  playing = p;
  if (p) clockOriginMs = performance.now() - clock * 1000; // re-anchor the monotonic clock on resume
}

export function isHap(path: string): boolean | undefined {
  return hapDecode.isHap(path);
}

export function getHapCanvas(path: string): HTMLCanvasElement | null {
  const s = active.get(path);
  return s && s.index >= 0 ? s.canvas : null;
}

export function getHapAspect(path: string): number | null {
  const info = hapDecode.getInfo(path);
  return info && info.width > 0 && info.height > 0 ? info.width / info.height : null;
}
