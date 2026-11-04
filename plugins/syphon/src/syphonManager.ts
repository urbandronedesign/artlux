import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SyphonServerDesc, SyphonShare } from './types';

// Loads the native Syphon receiver (native/syphon-receiver/syphon-receiver.node) in the main
// process — the sandboxed renderer can't require a .node. Mirrors spoutManager; degrades gracefully
// if the addon is absent (Syphon becomes unavailable rather than crashing).
//
// ⚠ GPU-ONLY, AND THAT IS A DECISION, NOT A LIMITATION. Frames leave here as an IOSurface and never
// as pixels. If the texture cannot be shared, Syphon reports itself INCOMPATIBLE and stops. It does
// not quietly switch to reading pixels back. Read the header of spoutManager.ts for the full account
// of why that road was removed on Windows; every word applies, and here there was never a reason to
// build one in the first place — an IOSurface is precisely what Electron wants on darwin.

interface SyphonNative {
  available(): boolean;
  startDirectory(): void;
  listServers(): SyphonServerDesc[];
  connect(name: string, appName: string): void;
  disconnect(): void;
  /** The server's frame as a shared texture. Null when there is nothing to hand over this poll. */
  receiveShared(): SyphonShare | null;
  /** Give back the +1 the frame carried. Must be called for EVERY frame — see types.ts. */
  releaseSurface(surface: Uint8Array): void;
}

const req = createRequire(__filename);

function loadNative(): SyphonNative | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'syphon-receiver.node'), // packaged
    join(process.cwd(), 'native/syphon-receiver/syphon-receiver.node'),
    join(__dirname, '../../native/syphon-receiver/syphon-receiver.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as SyphonNative;
    } catch (e) {
      // On macOS the commonest cause is not a missing file but a framework the addon cannot find —
      // a broken @rpath or an unsigned Syphon.framework. Both surface here as a load failure that
      // otherwise reads as "you didn't build it", so log the reason rather than swallowing it.
      console.warn('[syphon] native load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[syphon] native receiver loaded' : '[syphon] native receiver unavailable');
// Warm the server directory NOW, not on the first listing. It learns about servers from
// announcements delivered on run-loop turns, so a directory created the moment an operator opens the
// picker has heard nothing yet and shows an empty list — which reads as "my server is broken" and
// sends them to look in the wrong place.
try { native?.startDirectory(); } catch { /* non-fatal: listing just starts cold */ }

let timer: NodeJS.Timeout | null = null;
// What the live poll is currently doing, so a rate change can re-arm the timer WITHOUT reconnecting.
let currentKey: string | null = null; // `${name}\u0001${appName}` — null = not connected
let currentFps = 0;

const DEFAULT_FPS = 30;

/** Why Syphon is not running, or null when it is fine. Surfaced to the operator. */
export type Incompatibility = 'no-native' | 'no-shared-texture' | 'import-failed' | 'editor-crashed';

let incompatible: Incompatibility | null = null;
/**
 * Set once, for the rest of the session: the editor's renderer died while we were delivering.
 *
 * ⚠ A SYPHON SOURCE MUST COST AT MOST ONE CRASH, NEVER A LOOP. Second real-Mac test (2026-11-04): the
 * project reopened with a Syphon surface, so every recovery reload re-armed the receiver, the same bad
 * frames arrived, and the editor died again within a second — 1/3, 2/3, Safe Mode in under five
 * seconds. Nothing in JS saw a failure to react to (Chromium refused the import inside the GPU
 * process). So the death itself is the signal: trip, stop, and refuse every start() until restart —
 * the reload then comes back on the project, without Syphon, saying why.
 */
let tripped: Incompatibility | null = null;
let lastDeliveryAt = 0;
let onIncompatible: ((why: Incompatibility) => void) | null = null;

/** Did the native receiver load? Reported on the startup splash. */
export function available(): boolean { return !!native; }

/** Why Syphon cannot run here, or null. Null before anything has been attempted. */
export function incompatibility(): Incompatibility | null { return incompatible; }

export function listServers(): SyphonServerDesc[] {
  try { return native ? native.listServers() : []; } catch { return []; }
}

// Where a frame's texture goes. Returns false if it could not be handed over, which is terminal.
let onShared: ((s: SyphonShare) => boolean) | null = null;

/**
 * Wire the texture sink and the incompatibility report.
 *
 * `sink` returning false is not a per-frame hiccup: an import that fails once fails for the same
 * reason every time, so it stops the receiver rather than being retried.
 */
export function setSharedSink(
  sink: ((s: SyphonShare) => boolean) | null,
  report: (why: Incompatibility) => void,
): void {
  onShared = sink;
  onIncompatible = report;
}

function fail(why: Incompatibility): void {
  if (incompatible === why) return;
  incompatible = why;
  console.warn(`[syphon] unavailable: ${why} — Syphon needs GPU texture sharing and will not read pixels back`);
  onIncompatible?.(why);
  stop();
}

/** Were frames handed to the renderer within the last `ms`? */
export function deliveredWithin(ms: number): boolean { return Date.now() - lastDeliveryAt < ms; }

/** Stop now and refuse every later start() this session. See `tripped`. */
export function trip(why: Incompatibility): void {
  tripped = why;
  console.warn(`[syphon] disabled for this session: ${why}`);
  fail(why);
}

export function start(name: string, appName: string, fps: number | undefined): void {
  if (tripped) { incompatible = null; fail(tripped); return; } // re-announce to the reloaded editor
  if (!native) { fail('no-native'); return; }
  if (!onShared) { fail('no-shared-texture'); return; }
  const rate = Math.max(1, Math.min(240, Math.round(fps || DEFAULT_FPS)));
  const key = `${name}\u0001${appName}`;
  // A RATE CHANGE MUST NOT RECONNECT. Reconnecting drops the client and the server handshake has to
  // run again over the run loop, so an operator nudging Preferences ▸ Engine ▸ Engine rate would
  // blank every Syphon surface for a beat. Only a different server is worth that.
  if (timer && currentKey === key) {
    if (rate !== currentFps) { currentFps = rate; arm(); }
    return;
  }
  try { native.connect(name, appName); } catch (e) { console.error('[syphon] connect failed', e); return; }
  currentKey = key;
  currentFps = rate;
  incompatible = null; // a new connection deserves a fresh verdict
  arm();
}

/**
 * How fast to poll, in Hz. Follow the SERVER, not the consumer.
 *
 * ⚠ THE FLOOR IS SPOUT'S FLOOR, FOR SPOUT'S REASON. Tying the poll to the engine rate looks right —
 * one frame produced per frame consumed — and it visibly stutters: a 60 fps server polled at the
 * engine's 30 Hz is SAMPLED at half rate off an unrelated clock, so the picture advances by one
 * source frame on some ticks and two on others. The count is right; the motion is uneven.
 *
 * ⚠ THE CEILING IS *NOT* SPOUT'S CEILING, AND ITS REASONING MUST NOT BE COPIED HERE. Spout caps the
 * poll because `is_frame_new()` lies — against a sender that publishes no frame counts it answers
 * "yes" forever, so a surplus poll re-delivers the same picture at the full price of a copy and an
 * import. Syphon's `hasNewFrame` is backed by the server's published frame ID and is TRUTHFUL, so a
 * surplus poll costs one lock and one integer compare in the addon and returns null. The cap here is
 * ordinary restraint about timer frequency, nothing more.
 */
function pollHz(): number {
  return Math.min(120, Math.max(60, currentFps));
}

// (Re)start the poll. Split out so the rate can change without touching the connection.
function arm(): void {
  if (timer) clearInterval(timer);
  const periodMs = Math.max(1, Math.round(1000 / pollHz()));
  timer = setInterval(() => {
    let s: SyphonShare | null = null;
    try {
      s = native!.receiveShared();
      if (!s) return; // nothing to hand over this poll — ordinary, not a failure
      if (!onShared!(s)) fail('import-failed');
      else lastDeliveryAt = Date.now();
    } catch { /* transient receive error */ }
    finally {
      // ⚠ ALWAYS, AND IN A `finally`. Electron RETAINS the IOSurface on import rather than taking
      // ownership of it, so this +1 is still ours whether the hand-off succeeded, failed, or threw.
      // A missed release leaks a full-resolution surface per frame — at 60 Hz that is VRAM gone in
      // seconds. This is the macOS twin of the renderer's missed VideoFrame.close().
      if (s) { try { native!.releaseSurface(s.surface); } catch { /* already gone */ } }
    }
  }, periodMs);
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  currentKey = null;
  currentFps = 0;
  if (native) { try { native.disconnect(); } catch { /* */ } }
}
