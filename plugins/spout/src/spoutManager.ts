import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpoutFrame, SpoutShare } from './types';

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
  // The GPU path: the sender's texture re-shared as one Electron can import. Null whenever it is not
  // possible this poll — no new frame, a sender on another adapter, a driver that refused the share.
  receiveShared?(): SpoutShare | null;
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

// Where the pixels go when the GPU path is live. Set by the plugin entry; absent ⇒ CPU path only.
let onShared: ((s: SpoutShare) => boolean) | null = null;
// Whether to ASK for the GPU path at all (the window supports it and the operator has not turned it
// off). Distinct from whether it works — that is decided per frame, by the addon and by the import.
let gpuWanted = false;

/**
 * Choose the GPU path. `sink` returns false if the import failed, which permanently falls this
 * connection back to the CPU path — a source that cannot import will not start being able to, and
 * retrying per frame would pay the failure cost forever.
 */
export function setSharedSink(sink: ((s: SpoutShare) => boolean) | null, wanted: boolean): void {
  onShared = sink;
  gpuWanted = wanted && !!sink;
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
  gpuOk = true; // a new connection deserves a fresh try at the GPU path
  arm(onFrame);
}

// Latched OFF for this connection once the GPU path proves unusable — see setSharedSink. Module
// scope, not per-arm, so re-arming for a rate change does not silently retry a path already rejected.
let gpuOk = true;

/**
 * How fast to poll, in Hz. Follow the SENDER, not the consumer — bounded on both sides.
 *
 * ⚠ THE FLOOR EXISTS BECAUSE POLLING AT `engineFps` JUDDERS. Tying the poll to the engine rate looks
 * right — one frame produced per frame consumed, nothing wasted — and it visibly stutters. A 60 fps
 * sender polled at the engine's 30 Hz is SAMPLED at half rate off an unrelated clock, so the picture
 * advances by one source frame on some ticks and two on others. The count is right; the motion is
 * uneven. Poll fast enough to catch every frame the sender makes and the unevenness goes away, which
 * is why the floor is 60: that is what Spout senders overwhelmingly run at.
 *
 * ⚠ THE CEILING EXISTS BECAUSE SPOUT'S FRAME GATE CANNOT BE TRUSTED. `is_frame_new()` depends on the
 * sender publishing frame counts, and senders that do not leave it answering "yes" forever — so a
 * poll above the sender's rate does not cost a cheap null, it re-delivers the SAME picture at full
 * price. Measured against a 60 fps sender: polling at 92 Hz delivered 278 frames in 3 s of which only
 * 179 were distinct — 36% of the work was a copy of a frame already sent. Nothing above the sender's
 * rate buys anything, so there is no reason to chase a high engine rate upward.
 *
 * The paths differ only in what a wasted delivery costs — a ~2.5 ms GPU copy, against a ~9 ms
 * readback plus an 8.3 MB structured clone — so the CPU path gets no headroom at all.
 */
function pollHz(gpu: boolean): number {
  return gpu ? Math.min(120, Math.max(60, currentFps)) : 60;
}

// (Re)start the poll. Split out so the rate can change without touching the connection.
function arm(onFrame: (frame: SpoutFrame) => void): void {
  if (timer) clearInterval(timer);
  const useGpu = gpuWanted && gpuOk && !!native?.receiveShared;
  const periodMs = Math.max(1, Math.round(1000 / pollHz(useGpu)));
  timer = setInterval(() => {
    try {
      // ⚠ EXACTLY ONE of these per tick. Both consume the receiver's "is this frame new" edge, so
      // calling receiveShared() and then receiveFrame() would make each see only half the frames.
      if (gpuWanted && gpuOk && native!.receiveShared) {
        const s = native!.receiveShared!();
        if (s) {
          if (onShared!(s)) return;
          // The import failed. Stop asking, and RE-ARM: the CPU path cannot afford the faster poll
          // the GPU path was running at (see pollHz).
          console.warn('[spout] shared-texture import failed — falling back to the CPU path');
          gpuOk = false;
          arm(onFrame);
          return;
        } else {
          // No shared texture THIS poll. That is the ordinary "no new frame" answer, so it must not
          // fall anything back — but it also means no CPU read this tick, which is the point.
          return;
        }
      }
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
