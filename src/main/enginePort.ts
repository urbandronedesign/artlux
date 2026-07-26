import { MessageChannelMain, type BrowserWindow, type MessagePortMain } from 'electron';
import { IPC } from '../../shared/protocol';
import * as output from './transport/outputManager';

// A DIRECT ROAD FROM THE FRAME ENGINE TO THE WIRE.
//
// Packed universes currently travel renderer-main-thread → `ipcRenderer.send(IPC.FRAME)` → here. Once
// the engine runs in a Worker that is the wrong shape: the worker would have to hop back onto the main
// thread just to hand the bytes over, which reintroduces exactly the coupling the whole exercise is
// removing — a busy or stalled UI thread would once again pace the output.
//
// So main opens a MessageChannel and gives one end to the renderer, which relays it (untouched) into
// the worker. Frames then go worker → main with the main thread uninvolved.
//
// The pattern is not new here: it is the same one projector windows already use (main/projector.ts +
// the preload relay), including the reason the preload has to forward the port with window.postMessage
// rather than through the contextBridge — contextIsolation strips a MessagePort's methods.
//
// PAYLOAD IS IDENTICAL to IPC.FRAME: shared/frameCodec's encodeFrame output. This is a second road to
// the same door, not a second protocol, so the two engine modes cannot drift in what they emit.

let port: MessagePortMain | null = null;

/**
 * Open the channel and hand the renderer its end. Safe to call again — a second call replaces the
 * channel, which is what a renderer reload needs (the old port dies with the old page).
 */
export function openEnginePort(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  closeEnginePort();

  const { port1, port2 } = new MessageChannelMain();
  port = port1;
  port1.on('message', (e) => {
    const frame = e.data as ArrayBuffer | Uint8Array | undefined;
    if (!frame) return;
    // Same gate as the IPC path: with no transport configured there is nothing to send to, and
    // dropping here is cheaper than making every producer ask first.
    if (!output.isReady()) return;
    output.sendFrame(frame);
  });
  port1.start();

  // One line, once: which road output is taking is the first thing anyone debugging a silent venue
  // wants to know, and it costs nothing.
  console.log('[enginePort] output port open — frames may bypass the main thread');
  win.webContents.postMessage(IPC.ENGINE_PORT, null, [port2]);
}

export function closeEnginePort(): void {
  try { port?.close(); } catch { /* already gone with its window */ }
  port = null;
}
