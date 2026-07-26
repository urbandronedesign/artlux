// The renderer's end of the output MessagePort.
//
// Main opens a MessageChannel on every load and posts one end here (see main/enginePort.ts); the
// preload forwards it into the page with window.postMessage, because a MessagePort cannot survive the
// contextBridge. This module receives it and owns exactly two jobs:
//
//   • hand it to whoever will actually send frames — today the main-thread engine, and after WP-3.2
//     the worker, by transferring the port on so the main thread stops touching output entirely;
//   • say so out loud when it never arrives, because a silently absent port looks identical to a
//     healthy show that happens to be black.
//
// The bytes are shared/frameCodec's encodeFrame output — the same payload IPC.FRAME carries — so this
// is a second road to the same door, and the two engine modes cannot drift in what they emit.

type PortListener = (port: MessagePort) => void;

let port: MessagePort | null = null;
const waiting: PortListener[] = [];

// Announce readiness BEFORE the port can arrive. The preload buffers it until it hears this, so the
// ordering is safe either way, but announcing late means the port waits a needless frame or two.
if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { kind?: string } | undefined;
    if (data?.kind !== 'artlux:engine-port') return;
    const p = e.ports[0];
    if (!p) return;
    port = p;
    port.start();
    for (const cb of waiting.splice(0)) cb(port);
  });
  window.postMessage('artlux:engine-ready', '*');
}

/** The port, once it exists. Null before it arrives — callers must cope rather than assume. */
export function getFramePort(): MessagePort | null { return port; }

/** Run `cb` with the port, now if it is here and on arrival otherwise. */
export function onFramePort(cb: PortListener): void {
  if (port) cb(port);
  else waiting.push(cb);
}

/**
 * Send one encoded frame to main. Returns false when there is no port — the caller then falls back to
 * the IPC path, so a missing port degrades to the old behaviour instead of to silence.
 */
export function sendFrame(frame: ArrayBuffer): boolean {
  if (!port) return false;
  // ⚠ POSTED, NOT TRANSFERRED — and this cost an afternoon to find.
  //
  // `postMessage(buf, [buf])` is the standard zero-copy idiom and is perfectly legal on a DOM
  // MessagePort. Across Electron's renderer↔main port it is not: the frame ARRIVES (main's 'message'
  // handler fires, on time, every time) but `e.data` is **null**. No error, no warning, nothing in
  // either console — just a steady stream of empty messages and a show with no output. Every symptom
  // points at the gate you would naturally suspect (is the transport ready? is the port alive?) and
  // all of those are fine.
  //
  // So it is copied. At ~530 bytes per universe and a 44 Hz cap that is a rounding error, and the
  // alternative is a failure mode with no signal.
  port.postMessage(frame);
  return true;
}
