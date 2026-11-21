import { ipcMain, MessageChannelMain, type BrowserWindow, type WebContents } from 'electron';
import { IPC } from '../../shared/protocol';
import { postToPage } from './postToPage';

// MAIN'S HALF OF THE LIVE CHANNEL (E5/W4, shared/liveProtocol.ts): pair a client window with the
// ENGINE OWNER, then get out of the way.
//
// The owner is the editor window — it runs the frame engine, the timeline transport and the thumbnail
// and peaks caches, so it is the one producer of every live datum (plans/native-engine.md §9a, "one
// producer per datum"). A client is any other window that wants to watch them: a panel window (W5),
// or the editor itself in the harness's loop-back test. A client asks with IPC.LIVE_CONNECT; main opens
// a MessageChannel and hands one end to each side. After that the two talk directly — main is not on
// the per-frame path, exactly as with the projector bridge.
//
// Main also tells the owner when a client is GONE (closed, crashed, reloaded). The owner cannot reliably
// learn that from the port itself, and it must know: a client that dies mid-drag leaves a live
// fixture-channel override standing above the show (services/livePreview: "an entry must not outlive
// the hand"), so the owner releases everything that client was holding.

let owner: BrowserWindow | null = null;
let nextClientId = 1;
let ipcRegistered = false;
/** Every client that asked, by webContents, under a stable id (a client's reload keeps its id). */
const clients = new Map<WebContents, { clientId: number; label: string }>();

function pair(wc: WebContents, entry: { clientId: number; label: string }): void {
  if (!owner || owner.isDestroyed() || wc.isDestroyed()) return;
  if (wc.isCrashed() || owner.webContents.isCrashed()) return;   // see postToPage; a reload re-pairs
  const { port1, port2 } = new MessageChannelMain();
  // The owner first: a client's first message (`hello`) must find a port listening at the other end.
  // Messages posted to an unstarted port queue, so the order is belt-and-braces rather than required.
  postToPage(owner.webContents, IPC.LIVE_PORT, { role: 'owner', clientId: entry.clientId, label: entry.label }, [port1]);
  postToPage(wc, IPC.LIVE_PORT, { role: 'client', clientId: entry.clientId }, [port2]);
}

function drop(clientId: number): void {
  if (!owner || owner.isDestroyed()) return;
  postToPage(owner.webContents, IPC.LIVE_PORT, { role: 'drop', clientId });
}

/** Register the engine owner. Call once with the editor window, before it loads. */
export function initLiveHub(win: BrowserWindow): void {
  owner = win;
  // The OWNER reloaded (or crashed and was reloaded): every port it held died with the old page. Give
  // every other client a fresh pair. The owner's own page is not re-paired — if it is a client of
  // itself (the harness) its new page asks again, and an old entry would only be a duplicate.
  win.webContents.on('did-finish-load', () => {
    for (const [wc, entry] of [...clients]) {
      if (wc === win.webContents || wc.isDestroyed()) { clients.delete(wc); continue; }
      pair(wc, entry);
    }
  });
  win.on('closed', () => { if (owner === win) owner = null; });
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on(IPC.LIVE_CONNECT, (e, label?: string) => {
    const wc = e.sender;
    let entry = clients.get(wc);
    if (entry) {
      // The same window asking again = its page was replaced. The owner may still hold the old port
      // (and that client's drags); retire it before the new pair arrives under the same id.
      drop(entry.clientId);
      entry.label = String(label ?? entry.label);
    } else {
      entry = { clientId: nextClientId++, label: String(label ?? 'window') };
      clients.set(wc, entry);
      const id = entry.clientId;
      wc.once('destroyed', () => { clients.delete(wc); drop(id); });
      // A crashed page is not a destroyed webContents, and its drags must not outlive it either.
      wc.on('render-process-gone', () => drop(id));
    }
    pair(wc, entry);
  });
}
