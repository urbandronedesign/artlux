import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpoutFrame } from './types';

// Loads the native Spout receiver (native/spout-receiver/spout-receiver.node) in
// the main process — the sandboxed renderer can't require a .node, so frames
// cross via IPC. The addon downscales (aspect-preserving) to a runtime cap before
// handoff — 512² in the editor, lifted to 1080p in broadcast via setCap(). Mirrors the
// outputManager native-load pattern; degrades gracefully if the addon is absent
// (Spout becomes unavailable rather than crashing).

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

/** Did the native receiver load? Reported on the startup splash — a missing one is otherwise silent. */
export function available(): boolean { return !!native; }

// Set the aspect-preserving downscale cap (broadcast mode lifts it to 1080p).
export function setCap(w: number, h: number): void {
  if (native) { try { native.setCap(w, h); } catch (e) { console.warn('[spout] setCap failed', e); } }
}

export function listSenders(): string[] {
  try { return native ? native.listSenders() : []; } catch { return []; }
}

export function start(name: string, onFrame: (frame: SpoutFrame) => void): void {
  if (!native) return;
  try { native.connect(name); } catch (e) { console.error('[spout] connect failed', e); return; }
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    try {
      const f = native.receiveFrame();
      if (f) onFrame(f);
    } catch { /* transient receive error */ }
  }, 16); // ~60 Hz poll
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (native) { try { native.disconnect(); } catch { /* */ } }
}
