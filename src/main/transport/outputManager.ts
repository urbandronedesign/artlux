import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OutputConfig } from '../../../shared/protocol';
import { decodeFrame } from '../../../shared/frameCodec';
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
  getStats(): { pps: number; fps: number; universes: number };
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

export function getStats(): { pps: number; fps: number; universes: number } | null {
  return native ? native.getStats() : null;
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

export function sendFrame(frame: ArrayBuffer | Uint8Array): void {
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
