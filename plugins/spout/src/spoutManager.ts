import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpoutFrame } from './types';

// Loads the native Spout receiver (native/spout-receiver/spout-receiver.node) in
// the main process — the sandboxed renderer can't require a .node, so frames
// cross via IPC. The addon fits each frame (aspect-preserving, box-filtered) to a
// runtime cap before handoff — 1080p in EVERY mode, so a full-HD sender arrives
// intact and needs no resample at all. Mirrors the outputManager native-load
// pattern; degrades gracefully if the addon is absent (Spout becomes unavailable
// rather than crashing).
//
// ⚠ A 1080p RGBA frame is 8.3 MB, so the rate this polls at IS the bandwidth. It
// now follows the renderer's AppSettings.engineFps (carried on `spout:configure`,
// default 30) instead of a hardcoded 16 ms ≈ 60 Hz, because a frame produced
// faster than the engine consumes costs a full ~9 ms readback plus an 8.3 MB
// structured clone and is then dropped unread. Still to pay down: transferring
// the buffer instead of cloning it, and ultimately the shared-texture path that
// removes the readback altogether.

interface SpoutNative {
  setCap(w: number, h: number): void;
  listSenders(): string[];
  connect(name: string): void;
  disconnect(): void;
  receiveFrame(): SpoutFrame | null;
}

const req = createRequire(__filename);

function loadNative(): SpoutNative | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'spout-receiver.node'), // packaged
    join(process.cwd(), 'native/spout-receiver/spout-receiver.node'),
    join(__dirname, '../../native/spout-receiver/spout-receiver.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as SpoutNative;
    } catch (e) {
      console.warn('[spout] native load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[spout] native receiver loaded' : '[spout] native receiver unavailable');

let timer: NodeJS.Timeout | null = null;
// What the live poll is currently doing, so a rate change can re-arm the timer WITHOUT reconnecting
// (see start()). Null name = not connected.
let currentName: string | null = null;
let currentFps = 0;

// Fallback when the renderer names no rate. 30 matches AppSettings.engineFps's default — the rate the
// frame engine actually consumes at — not the ~60 Hz this used to poll at unconditionally.
const DEFAULT_FPS = 30;

/** Did the native receiver load? Reported on the startup splash — a missing one is otherwise silent. */
export function available(): boolean { return !!native; }

// Set the aspect-preserving downscale cap (broadcast mode lifts it to 1080p).
export function setCap(w: number, h: number): void {
  if (native) { try { native.setCap(w, h); } catch (e) { console.warn('[spout] setCap failed', e); } }
}

export function listSenders(): string[] {
  try { return native ? native.listSenders() : []; } catch { return []; }
}

export function start(name: string, fps: number | undefined, onFrame: (frame: SpoutFrame) => void): void {
  if (!native) return;
  const rate = Math.max(1, Math.min(240, Math.round(fps || DEFAULT_FPS)));
  // A RATE CHANGE MUST NOT RECONNECT. connect() resets the receiver, and the first frame after a
  // connect is all zeros — so an operator nudging Preferences ▸ Engine ▸ Engine rate would blink
  // every Spout surface black. Only a different sender is worth a reconnect.
  if (timer && currentName === name) {
    if (rate !== currentFps) { currentFps = rate; arm(onFrame); }
    return;
  }
  try { native.connect(name); } catch (e) { console.error('[spout] connect failed', e); return; }
  currentName = name;
  currentFps = rate;
  arm(onFrame);
}

// (Re)start the poll at `currentFps`. Split out so the rate can change without touching the connection.
function arm(onFrame: (frame: SpoutFrame) => void): void {
  if (timer) clearInterval(timer);
  // Polling faster than the sender is nearly free — receiveFrame() returns null when the frame is not
  // new, so the expensive path (readback + convert + IPC) runs at the SENDER's rate, not this one.
  // Polling faster than the engine CONSUMES is not free at all: it pays that full cost for a frame
  // nobody reads. So this tracks the consumer, which is why the renderer sends it.
  const periodMs = Math.max(1, Math.round(1000 / currentFps));
  timer = setInterval(() => {
    try {
      const f = native!.receiveFrame();
      if (f) onFrame(f);
    } catch { /* transient receive error */ }
  }, periodMs);
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  currentName = null;
  currentFps = 0;
  if (native) { try { native.disconnect(); } catch { /* */ } }
}
