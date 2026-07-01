import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NdiFrame } from './types';

// Loads the native NDI addon (native/ndi/ndi.node) in the main process — the sandboxed
// renderer can't require a .node, so frames cross via IPC. Mirrors spoutManager for receive;
// adds multi-instance send (one named NDI source per projector output). Degrades gracefully
// if the addon or the NDI runtime is absent (NDI features become unavailable, not crashes).

interface NdiNative {
  runtimeAvailable(): boolean;
  setRecvCap(w: number, h: number): void;
  listSources(): string[];
  recvConnect(name: string): void;
  recvDisconnect(): void;
  recvFrame(): NdiFrame | null;
  sendCreate(id: string, name: string): void;
  sendFrame(id: string, width: number, height: number, data: Buffer): void;
  sendDestroy(id: string): void;
}

const req = createRequire(__filename);

// The addon links Processing.NDI.Lib.x64.dll — make sure it's on the DLL search path before
// loading. The NDI Runtime installer sets NDI_RUNTIME_DIR_V6; also try the SDK + known paths
// so NDI works even if the system PATH wasn't refreshed since install.
function ensureNdiOnPath(): void {
  if (process.platform !== 'win32') return;
  const sdk = process.env.NDI_SDK_DIR;
  const dirs = [
    process.env.NDI_RUNTIME_DIR_V6,
    process.env.NDI_RUNTIME_DIR_V5,
    'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6',
    sdk ? join(sdk, 'Bin', 'x64') : undefined,
  ].filter((d): d is string => !!d && existsSync(d));
  if (dirs.length) process.env.PATH = `${dirs.join(';')};${process.env.PATH ?? ''}`;
}

function loadNative(): NdiNative | null {
  ensureNdiOnPath();
  const candidates = [
    join(process.resourcesPath ?? '', 'ndi.node'), // packaged
    join(process.cwd(), 'native/ndi/ndi.node'),
    join(__dirname, '../../native/ndi/ndi.node'),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as NdiNative;
    } catch (e) {
      console.warn('[ndi] native load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
console.log(native ? '[ndi] native addon loaded' : '[ndi] native addon unavailable');
if (native) {
  try { console.log(`[ndi] runtime available: ${native.runtimeAvailable()}`); }
  catch (e) { console.log('[ndi] runtimeAvailable threw:', e); }
}

// runtimeAvailable() throws/returns false if the NDI runtime DLL isn't installed.
export function available(): boolean {
  try { return native ? native.runtimeAvailable() : false; } catch { return false; }
}

// ---- Receive (single live source, like Spout) ----
let recvTimer: NodeJS.Timeout | null = null;

// Set the aspect-preserving receive cap (broadcast mode lifts it to 1080p).
export function setRecvCap(w: number, h: number): void {
  if (native) { try { native.setRecvCap(w, h); } catch (e) { console.warn('[ndi] setRecvCap failed', e); } }
}

export function listSources(): string[] {
  try { return native ? native.listSources() : []; } catch { return []; }
}

export function startRecv(name: string, onFrame: (frame: NdiFrame) => void): void {
  if (!native) return;
  try { native.recvConnect(name); } catch (e) { console.error('[ndi] connect failed', e); return; }
  if (recvTimer) clearInterval(recvTimer);
  recvTimer = setInterval(() => {
    try {
      const f = native.recvFrame();
      if (f) onFrame(f);
    } catch { /* transient receive error */ }
  }, 16); // ~60 Hz poll
}

export function stopRecv(): void {
  if (recvTimer) { clearInterval(recvTimer); recvTimer = null; }
  if (native) { try { native.recvDisconnect(); } catch { /* */ } }
}

// ---- Send (one named NDI source per projector output) ----
const senders = new Set<string>();

export function sendConfigure(outputId: string, enabled: boolean, name: string): void {
  if (!native) return;
  if (enabled) {
    if (senders.has(outputId)) return;
    try { native.sendCreate(outputId, name); senders.add(outputId); }
    catch (e) { console.error('[ndi] send create failed', e); }
  } else {
    sendDestroy(outputId);
  }
}

export function sendFrame(outputId: string, width: number, height: number, data: Buffer): void {
  if (!native || !senders.has(outputId)) return;
  try { native.sendFrame(outputId, width, height, data); } catch { /* transient send error */ }
}

export function sendDestroy(outputId: string): void {
  if (!senders.has(outputId)) return;
  senders.delete(outputId);
  if (native) { try { native.sendDestroy(outputId); } catch { /* */ } }
}

export function stopAllSenders(): void {
  for (const id of [...senders]) sendDestroy(id);
}
