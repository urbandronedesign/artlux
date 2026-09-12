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

let warnedNoSerial = false;

// THE LAST FRAME'S SHAPE, kept so the app can put the rig out on the way down (see blackout()).
// A reference, not a copy: each frame arrives as its own buffer over IPC, so this is one pointer
// assignment per frame and costs nothing at 44 Hz. It is the SHAPE we need — which targets, which
// universes, how many channels each — because main does not otherwise know the patch.
let lastFrame: ArrayBuffer | null = null;

export function sendFrame(frame: ArrayBuffer | Uint8Array): void {
  lastFrame = toArrayBuffer(frame);
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
