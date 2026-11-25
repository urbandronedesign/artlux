import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputConfig, OutputStats } from '../../../shared/protocol';
import { decodeFrame, encodeFrame } from '../../../shared/frameCodec';
import * as artnet from './artnet';
import * as sacn from './sacn';

// Prefers the native Rust engine (native/output-engine/output-engine.node) when
// present; otherwise routes to the TypeScript Art-Net/sACN transports. The native
// addon owns a dedicated send thread: pushFrame() hands off the binary frame
// (one memcpy + condvar notify) and the thread paces UDP transmission.
// Build the addon with `npm run build:native`.

interface NativeEngine {
  configure(broadcast: boolean, fps: number, keepAlive: boolean, sync: boolean): void;
  isReady(): boolean;
  pushFrame(frame: Buffer): void;
  getStats(): { pps: number; fps: number; universes: number; serialOk?: number; serialDown?: number };
  /** Present only on engines built with USB DMX support; older .node files simply lack it. */
  listSerialDevices?(): Array<{ path: string; label: string }>;
  /** E6i (Windows): pictures to the native render engine through shared memory (native/output-engine/src/shm.rs). */
  shmWrite?(name: string, cap: number, slot: number, seq: number, data: Buffer): boolean;
  shmClose?(name: string): void;
  close(): void;
}

const req = createRequire(__filename);

function loadNative(): NativeEngine | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'output-engine.node'), // packaged (extraResources)
    join(process.cwd(), 'native/output-engine/output-engine.node'),
    join(__dirname, '../../native/output-engine/output-engine.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as NativeEngine;
    } catch (e) {
      console.warn('[output] native engine load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[output] native Rust engine loaded' : '[output] using TypeScript transport');

function toBuffer(frame: ArrayBuffer | Uint8Array): Buffer {
  return Buffer.isBuffer(frame)
    ? frame
    : frame instanceof Uint8Array
      ? Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
      : Buffer.from(frame);
}

function toArrayBuffer(frame: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (frame instanceof ArrayBuffer) return frame;
  return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer;
}

export function configure(cfg: OutputConfig): void {
  if (native) { native.configure(cfg.broadcast, cfg.fps ?? 44, cfg.keepAlive ?? true, cfg.sync ?? false); return; }
  artnet.configure(cfg);
  sacn.configure(cfg);
}

export function getStats(): OutputStats | null {
  if (!native) return null;
  const s = native.getStats();
  // An engine built before USB DMX health reporting simply lacks these, so default them rather than
  // letting `undefined` reach a Prometheus gauge (which would export NaN and break the whole scrape).
  return { ...s, serialOk: s.serialOk ?? 0, serialDown: s.serialDown ?? 0 };
}

export function isReady(): boolean {
  if (native) return native.isReady();
  return artnet.isReady() || sacn.isReady();
}

// Is the native Rust send engine loaded — NOT "is output configured" (that's isReady). Without it the
// TypeScript transport still sends Art-Net/sACN, so this is degraded, not dead: no dedicated send
// thread, no pacer. The startup splash reports it, because "output looks fine but jitters at 44fps" is
// otherwise a mystery nobody connects back to a missing .node.
export function isLoaded(): boolean { return !!native; }
/** E6i: copy a picture into a shared-memory section for the native render engine (false: not available here). */
export function shmWrite(name: string, cap: number, slot: number, seq: number, data: Uint8Array): boolean {
  return !!native?.shmWrite?.(name, cap, slot, seq, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}
export function shmClose(name: string): void { native?.shmClose?.(name); }

let warnedNoSerial = false;

// THE LAST FRAME'S SHAPE, kept so the app can put the rig out on the way down (see blackout()).
// A reference, not a copy: each frame arrives as its own buffer over IPC, so this is one pointer
// assignment per frame and costs nothing at 44 Hz. It is the SHAPE we need — which targets, which
// universes, how many channels each — because main does not otherwise know the patch.
let lastFrame: ArrayBuffer | null = null;

// E1f: WHO DRIVES THE WIRE. While the native engine owns it (main/engineHost.ts), the app's frames are
// still RECORDED — blackout() puts the rig out over the last frame's shape on the way down — but not sent:
// one sender, never two. The predicate is false the instant the engine dies or refuses a document, so the
// next app frame goes out (the app's path is the fallback). Null (no engine) = always the app.
let wireOwner: (() => boolean) | null = null;
let muted = false;
export function setWireOwner(fn: (() => boolean) | null): void { wireOwner = fn; }
// E6i step 3 — THE APP'S FRAMES STAY OFF THE WIRE while the native engine is in charge (engineHost.appEmergency null),
// even in the moments it does not own it: at boot before its first frame, and across a restart, where its HELD frame
// is on the wire. Only an emergency (the engine refused, gave up, is missing, refuses this document) or the quit's
// blackout lets them through. Null (no engine this run) = never silenced.
let appSilenced: (() => boolean) | null = null;
export function setAppSilenced(fn: (() => boolean) | null): void { appSilenced = fn; }

// E6h — THE ENGINE'S LAST FRAME, HELD ACROSS ITS DEATH (main/engineHost.ts; engine hold.rs). The moment an engine
// that owned the wire dies, engineHost hands its last frame here and it goes out through THIS sender, whose
// keep-alive repeats it — so the wire never goes dark between the death and the restarted engine taking it back.
// It is let go the moment either (a) the app's own next frame goes out (today's fallback: live frames beat a held
// one) or (b) a restarted engine owns the wire again (releaseHold: an EMPTY frame, so the keep-alive stops — one
// sender, never two). Native sender only: the TS fallback has no keep-alive to hold with.
let holding = false;
export function hold(frame: Uint8Array): boolean {
  if (!native) return false;
  lastFrame = toArrayBuffer(frame);   // blackout() at quit then knows the patch even with no app frame (E6i)
  native.pushFrame(toBuffer(frame));
  holding = true;
  muted = false;
  return true;
}
export function releaseHold(): void {
  if (!holding) return;
  holding = false;
  muted = true;
  if (native) native.pushFrame(toBuffer(new Uint8Array(4)));
}
export function isHolding(): boolean { return holding; }

// TEST HOOK (E6h): ARTLUX_NO_APP_WIRE=1 — the app's own frames never reach the wire, as when there is no browser
// engine (E6i). Only then does the hold alone bridge an engine death; scripts/test-engine-hold.cjs runs with it.
const NO_APP_WIRE = process.env.ARTLUX_NO_APP_WIRE === '1';

export function sendFrame(frame: ArrayBuffer | Uint8Array): void {
  if (NO_APP_WIRE) { if (!lastFrame) lastFrame = toArrayBuffer(frame); return; }
  lastFrame = toArrayBuffer(frame);
  if (wireOwner?.()) {
    // ⚠ STOPPING THE PUSHES IS NOT ENOUGH. The send thread's KEEP-ALIVE repeats the last frame it was given,
    // forever — measured: after the handover the app's addon kept sending its last frame beside the
    // engine's (scripts/test-native-takeover.cjs). On the way into muting it is handed an EMPTY frame (no
    // targets), so there is nothing left to repeat. The engine does the same when it hands the wire back.
    if (!muted) {
      muted = true;
      const empty = new Uint8Array(4);   // shared/frameCodec: a u32 target count of 0
      if (native) native.pushFrame(toBuffer(empty));
      else { artnet.sendFrame({ targets: [] }); sacn.sendFrame({ targets: [] }); }
    }
    return;
  }
  if (appSilenced?.()) {
    if (holding) return;   // the engine's held frame stays on the wire until a restarted engine takes it
    if (!muted) {
      muted = true;
      if (native) native.pushFrame(toBuffer(new Uint8Array(4)));
      else { artnet.sendFrame({ targets: [] }); sacn.sendFrame({ targets: [] }); }
    }
    return;
  }
  muted = false;
  holding = false;   // the app's live frame replaces a held one (an emergency: the engine is not coming back)
  if (native) {
    native.pushFrame(toBuffer(frame)); // hand off to the dedicated send thread
    return;
  }
  // TS fallback: decode the binary frame and route per protocol.
  const targets = decodeFrame(toArrayBuffer(frame));
  if (!targets.length) return;
  // 'enttec' TARGETS ARE DROPPED HERE, DELIBERATELY. USB DMX lives in the Rust engine (it needs a
  // serial port and a per-port writer thread); this pure-TS path has neither. Without the explicit
  // filter an enttec target would fall into the `!== 'sacn'` bucket and be blasted over UDP to a
  // hostname of "COM3" — a stream of packets to nowhere, with no error to explain it.
  const serial = targets.filter(t => t.protocol === 'enttec');
  if (serial.length && !warnedNoSerial) {
    warnedNoSerial = true;
    console.warn('[output] USB DMX needs the native engine — those universes are not being sent');
  }
  const artnetTargets = targets.filter(t => t.protocol === 'artnet');
  const sacnTargets = targets.filter(t => t.protocol === 'sacn');
  if (artnetTargets.length) artnet.sendFrame({ targets: artnetTargets });
  if (sacnTargets.length) sacn.sendFrame({ targets: sacnTargets });
}

/**
 * Send one all-zero frame over the patch that is already live — every target, every universe, every
 * channel the last real frame covered.
 *
 * WHY IT EXISTS. Closing the app stops the stream; it does not turn anything off. Art-Net and sACN
 * nodes hold the last level they were sent (that is what the engine's own keep-alive relies on), so
 * quitting used to leave a venue lit at whatever was on screen at the time — a white wash, a lighting
 * state mid-cue — with no app running to fix it and nobody necessarily in the building. On a remote
 * shutdown the operator is by definition not there to see it.
 *
 * `sparse` is forced OFF: a sparse target skips universes that have not changed since the last send,
 * and the whole point here is that every universe must be written, including ones that happen to
 * already be at zero in the engine's own cache.
 *
 * Returns false when there is nothing to black out — no frame has ever been sent, so nothing on the
 * wire came from us and there is no patch to write to.
 */
export function blackout(): boolean {
  if (!lastFrame) return false;
  try {
    const targets = decodeFrame(lastFrame);
    if (!targets.length) return false;
    for (const t of targets) {
      t.sparse = false;
      for (const k of Object.keys(t.universes)) {
        t.universes[Number(k)] = new Array(t.universes[Number(k)].length).fill(0);
      }
    }
    sendFrame(encodeFrame(targets));
    return true;
  } catch (e) {
    console.error('[output] blackout failed', e);
    return false;
  }
}

/**
 * Block this thread for `ms` so the send thread can actually transmit before the process exits.
 *
 * ONLY MEANINGFUL WITH THE NATIVE ENGINE, and that is why it is gated on it. The Rust pacer owns its
 * own OS thread, so sleeping the main thread does not stop it sending — it is exactly the wait we
 * want. The TypeScript fallback sends from THIS thread, where blocking would prevent the very write
 * we are waiting for, so it gets no wait at all (its dgram sends are issued inline and the teardown
 * that follows gives them the same grace anyway).
 *
 * A synchronous wait, not a timer: every caller is on a process-exit path, where there is no next
 * tick to come back to.
 */
export function drain(ms: number): void {
  if (!native || ms <= 0) return;
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — the teardown that follows is the grace period */ }
}

/**
 * USB serial devices that could be a DMX interface, for the Outputs picker.
 *
 * Returns [] when the native engine is unavailable, which is honest rather than convenient: without
 * it USB DMX cannot be sent at all, so offering devices to select would promise output that will
 * never arrive.
 */
export function listSerialDevices(): Array<{ path: string; label: string }> {
  try {
    return native?.listSerialDevices?.() ?? [];
  } catch (e) {
    console.warn('[output] serial device enumeration failed', e);
    return [];
  }
}

export function close(): void {
  if (native) { native.close(); return; }
  artnet.close();
  sacn.close();
}
