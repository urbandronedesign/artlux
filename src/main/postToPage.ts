import type { MessagePortMain, WebContents } from 'electron';

// HANDING A PAGE A MESSAGE PORT, WITHOUT FREEZING MAIN.
//
// ⚠ `webContents.postMessage` to a page whose renderer has CRASHED blocks the main process. Measured
// 2026-11-21 (E5/W5b-2): a panel window's page crashed, the Show Host was then killed, and main's restart
// path reconnected every window — including the crashed one — and main stopped answering for good (the
// CDP endpoint, every IPC, every window). The control run, same steps without the crash, stayed
// responsive. A frozen main is a stopped show: it carries the output engine's IPC and every window.
//
// So every place main hands a page a port goes through here. A crashed or destroyed page is skipped and
// its ports are closed; a crashed page that is reloaded gets a fresh port from its own did-finish-load,
// as it always did.
const warned = new WeakSet<WebContents>();

export function postToPage(wc: WebContents, channel: string, payload: unknown, ports: MessagePortMain[] = []): boolean {
  if (wc.isDestroyed() || wc.isCrashed()) {
    for (const p of ports) { try { p.close(); } catch { /* already closed */ } }
    if (!wc.isDestroyed() && !warned.has(wc)) {
      warned.add(wc);
      console.warn(`[postToPage] not sending ${channel} to a crashed page (it gets a fresh port when it reloads)`);
    }
    return false;
  }
  wc.postMessage(channel, payload, ports);
  return true;
}
