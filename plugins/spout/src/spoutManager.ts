import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpoutShare } from './types';

// Loads the native Spout receiver (native/spout-receiver/spout-receiver.node) in the main process —
// the sandboxed renderer can't require a .node. Mirrors the outputManager native-load pattern;
// degrades gracefully if the addon is absent (Spout becomes unavailable rather than crashing).
//
// ⚠ GPU-ONLY, AND THAT IS A DECISION, NOT A LIMITATION. Frames leave here as a shared-texture handle
// and never as pixels. If the texture cannot be shared — no such API in this Electron, a sender on a
// different GPU, a driver that refuses — Spout reports itself INCOMPATIBLE and stops. It does not
// quietly switch to reading pixels back.
//
// The readback path existed and worked. It also cost ~9 ms of main-thread stall and an 8.3 MB
// structured clone per frame at 1080p, and as a silent fallback it turned a hardware fact the
// operator could act on ("this machine cannot share GPU textures") into a mystery they could not
// ("the picture is soft and the app is slow, and nothing says why"). An honest refusal is worth more
// than a degraded picture nobody can account for.

interface SpoutNative {
  listSenders(): string[];
  connect(name: string): void;
  disconnect(): void;
  /** The sender's frame as a shared texture. Null when there is nothing to hand over this poll. */
  receiveShared(): SpoutShare | null;
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

// Used only when the renderer names no rate; the poll floor below makes the exact value moot.
const DEFAULT_FPS = 30;

/** Why Spout is not running, or null when it is fine. Surfaced to the operator — see `incompatible`. */
export type Incompatibility = 'no-native' | 'no-shared-texture' | 'import-failed';

let incompatible: Incompatibility | null = null;
let onIncompatible: ((why: Incompatibility) => void) | null = null;

/** Did the native receiver load? Reported on the startup splash — a missing one is otherwise silent. */
export function available(): boolean { return !!native; }

/** Why Spout cannot run here, or null. Null before anything has been attempted. */
export function incompatibility(): Incompatibility | null { return incompatible; }

export function listSenders(): string[] {
  try { return native ? native.listSenders() : []; } catch { return []; }
}

// Where a frame's texture goes. Returns false if it could not be handed over, which is terminal —
// see the poll.
let onShared: ((s: SpoutShare) => boolean) | null = null;

/**
 * Wire the texture sink and the incompatibility report.
 *
 * `sink` returning false is not a per-frame hiccup: an import that fails once fails for the same
 * reason every time (wrong GPU, unusable format), so it stops the receiver rather than being retried.
 */
export function setSharedSink(
  sink: ((s: SpoutShare) => boolean) | null,
  report: (why: Incompatibility) => void,
): void {
  onShared = sink;
  onIncompatible = report;
}

function fail(why: Incompatibility): void {
  if (incompatible === why) return;
  incompatible = why;
  console.warn(`[spout] unavailable: ${why} — Spout needs GPU texture sharing and will not read pixels back`);
  onIncompatible?.(why);
  stop();
}

export function start(name: string, fps: number | undefined, ): void {
  if (!native) { fail('no-native'); return; }
  if (!onShared) { fail('no-shared-texture'); return; }
  const rate = Math.max(1, Math.min(240, Math.round(fps || DEFAULT_FPS)));
  // A RATE CHANGE MUST NOT RECONNECT. connect() resets the receiver, and the first frame after a
  // connect is all zeros — so an operator nudging Preferences ▸ Engine ▸ Engine rate would blink
  // every Spout surface black. Only a different sender is worth a reconnect.
  if (timer && currentName === name) {
    if (rate !== currentFps) { currentFps = rate; arm(); }
    return;
  }
  try { native.connect(name); } catch (e) { console.error('[spout] connect failed', e); return; }
  currentName = name;
  currentFps = rate;
  incompatible = null; // a new connection deserves a fresh verdict
  arm();
}

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
 * price (a GPU copy, an import and a hand-off). Measured against a 60 fps sender: polling at 92 Hz
 * delivered 278 frames in 3 s of which only 179 were distinct — 36% of the work was a copy of a frame
 * already sent. Nothing above the sender's rate buys anything.
 */
function pollHz(): number {
  return Math.min(120, Math.max(60, currentFps));
}

// (Re)start the poll. Split out so the rate can change without touching the connection.
function arm(): void {
  if (timer) clearInterval(timer);
  const periodMs = Math.max(1, Math.round(1000 / pollHz()));
  timer = setInterval(() => {
    try {
      const s = native!.receiveShared();
      if (!s) return; // nothing to hand over this poll — ordinary, not a failure
      // A hand-off that fails will fail identically next time, so this is terminal rather than a
      // frame to skip. `fail` stops the poll.
      if (!onShared!(s)) fail('import-failed');
    } catch { /* transient receive error */ }
  }, periodMs);
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  currentName = null;
  currentFps = 0;
  if (native) { try { native.disconnect(); } catch { /* */ } }
}
