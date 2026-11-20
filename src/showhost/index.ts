// THE SHOW HOST — an Electron utilityProcess that holds the authoritative project document.
//
// plans/native-engine.md §9a, W3. Every window is a REPLICA of what lives here; from W5 a detached panel
// window reads and writes the document through this process instead of through the editor, which is
// what lets any panel live in its own window without a second copy of the show drifting from the first.
//
// WHAT IT IS TODAY (W3a): the authority for the two W1 stores, kept in lockstep with the editor. The
// editor hands over its whole state on connect (so a host restart, or a renderer reload, converges on
// what the operator is looking at), and every slice write after that arrives in order. Undo moves here
// in W3b, persistence and the close guard in W3c.
//
// WHAT IT MUST NEVER BECOME: a second engine. No decode, no GPU, no output, no timers that write the
// document. It orders writes and remembers them. The frame engine stays in the editor renderer, reading
// the replica (plan §9a rule 2), so nothing here is on the show-critical path: if this process dies, the
// editor keeps editing and the show keeps playing, and main starts a fresh one.
//
// Plain Node + Electron's parentPort. It imports the dependency-free store core and the wire types only.

import { createDocStore, type DocStore } from '../../shared/docStore';
import { sliceDigest, type ClientToHost, type HostConnect, type HostToClient, type Slices, type StoreName } from '../../shared/showHostProtocol';

// Electron's MessagePortMain, as far as this file uses it (the utility process has no `electron` module
// import for it; the ports arrive on parentPort's message event).
interface PortLike {
  on(ev: 'message', fn: (e: { data: unknown }) => void): void;
  on(ev: 'close', fn: () => void): void;
  postMessage(msg: unknown): void;
  start(): void;
  close(): void;
}
interface Client { id: number; port: PortLike; lastSeq: number; role: 'editor' | 'panel' | null }

const stores: Record<StoreName, DocStore<Slices>> = {
  doc: createDocStore<Slices>({}),
  session: createDocStore<Slices>({}),
};
const clients = new Map<number, Client>();

function send(c: Client, msg: HostToClient): void {
  try { c.port.postMessage(msg); } catch (e) { console.warn(`[showHost] client ${c.id} send failed:`, (e as Error).message); }
}

/** Relay one accepted write to every OTHER client (the writer already shows it). */
function relay(from: Client, store: StoreName, key: string, value: unknown): void {
  for (const c of clients.values()) {
    if (c === from) continue;
    send(c, { t: 'patch', store, key, value, acked: c.lastSeq });
  }
}

function onMessage(c: Client, raw: unknown): void {
  const m = raw as ClientToHost;
  switch (m?.t) {
    case 'hello':
      c.role = m.role;
      return;
    case 'set': {
      if (m.store !== 'doc' && m.store !== 'session') return;
      c.lastSeq = m.seq;
      // Object.is no-op inside the store: a structured-cloned value is always a new object, so this
      // always lands — it is the replica that decides whether anything changed, never this side.
      stores[m.store].set(m.key, m.value);
      relay(c, m.store, m.key, m.value);
      return;
    }
    case 'digest': {
      const digests: Record<string, string> = {};
      for (const name of ['doc', 'session'] as StoreName[]) {
        const all = stores[name].get();
        for (const k of Object.keys(all)) digests[`${name}.${k}`] = sliceDigest(all[k]);
      }
      send(c, { t: 'digest', req: m.req, digests });
      return;
    }
    default:
      console.warn('[showHost] unknown message', (raw as { t?: unknown })?.t);
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data as HostConnect;
  const port = e.ports[0] as unknown as PortLike | undefined;
  if (msg?.t !== 'connect' || !port) return;
  // A reconnect under the same id (a renderer reload) replaces the old client outright.
  clients.get(msg.clientId)?.port.close();
  const c: Client = { id: msg.clientId, port, lastSeq: 0, role: null };
  clients.set(c.id, c);
  port.on('message', (ev) => { try { onMessage(c, ev.data); } catch (err) { console.error('[showHost] message failed:', err); } });
  port.on('close', () => { if (clients.get(c.id) === c) clients.delete(c.id); });
  port.start();
  send(c, { t: 'welcome', clientId: c.id, pid: process.pid });
  console.log(`[showHost] client ${c.id} connected`);
});

console.log(`[showHost] up (pid ${process.pid})`);
