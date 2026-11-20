// THE SHOW HOST — an Electron utilityProcess that holds the authoritative project document.
//
// plans/native-engine.md §9a, W3. Every window is a REPLICA of what lives here; from W5 a detached panel
// window reads and writes the document through this process instead of through the editor, which is
// what lets any panel live in its own window without a second copy of the show drifting from the first.
//
// WHAT IT IS TODAY (W3a): the authority for the two W1 stores, kept in lockstep with the editor. The
// editor hands over its whole state on connect (so a host restart, or a renderer reload, converges on
// what the operator is looking at), and every slice write after that arrives in order. Since W3b the
// UNDO STACKS live here too (below); persistence and the close guard follow in W3c.
//
// WHAT IT MUST NEVER BECOME: a second engine. No decode, no GPU, no output, no timers that write the
// document. It orders writes and remembers them. The frame engine stays in the editor renderer, reading
// the replica (plan §9a rule 2), so nothing here is on the show-critical path: if this process dies, the
// editor keeps editing and the show keeps playing, and main starts a fresh one.
//
// Plain Node + Electron's parentPort. It imports the dependency-free store core and the wire types only.

import { createDocStore, type DocStore } from '../../shared/docStore';
import { shareEqual } from '../../shared/shareEqual';
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

// ── UNDO / REDO (W3b) ───────────────────────────────────────────────────────────────────────────────
// The same model App's useHistory had in-process (hooks/useHistory.ts): snapshots of the undoable doc
// slices, held BY REFERENCE, capped in depth, FIFO when full. References are cheap here for the same
// reason they were there: nothing in this process mutates a value, and every write is folded into the
// previous value with shareEqual, so consecutive snapshots share every part that did not change.
//
// The present document for an op is the host's copy with the client's `present` overrides on top (see
// the protocol): the client flushed its writes first, so the copy is current except for writes it made
// earlier in the same handler and has not rendered yet, which is exactly what the overrides carry.
const MAX_DEPTH = 100;
let undoable: string[] = [];
let past: Slices[] = [];
let future: Slices[] = [];

function presentDoc(overrides: Slices): Slices {
  const doc = stores.doc.get();
  const out: Slices = {};
  for (const k of undoable) out[k] = k in overrides ? shareEqual(doc[k], overrides[k]) : doc[k];
  return out;
}

/** Restore a snapshot: write each slice that differs, and patch EVERY client (the asker included). */
function restore(snap: Slices): void {
  for (const k of undoable) {
    if (!(k in snap) || Object.is(stores.doc.getSlice(k), snap[k])) continue;
    stores.doc.set(k, snap[k]);
    for (const c of clients.values()) send(c, { t: 'patch', store: 'doc', key: k, value: snap[k], acked: c.lastSeq });
  }
}

function historyState(): void {
  for (const c of clients.values()) send(c, { t: 'historyState', canUndo: past.length > 0, canRedo: future.length > 0, depth: past.length });
}

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
      // The editor names the undoable slices. A changed list means a different editor build: stacks
      // recorded over the old list would restore the wrong set of slices, so they are dropped.
      if (Array.isArray(m.undoable)) undoable = m.undoable.slice();
      // A NEW EDITOR PAGE STARTS A NEW HISTORY, as it did when the stacks lived in the page: a reload
      // (crash recovery, a dev reload) must not let Ctrl+Z restore a snapshot recorded against the
      // previous page's document. (A panel window joining, from W5, keeps the history.)
      if (m.role === 'editor') { past = []; future = []; historyState(); }
      return;
    case 'set': {
      if (m.store !== 'doc' && m.store !== 'session') return;
      c.lastSeq = m.seq;
      // Folded into the previous value: the parts that did not change keep their identity, so undo
      // snapshots share structure, and a write that changed nothing is a no-op (and is not relayed).
      const prev = stores[m.store].getSlice(m.key);
      const next = shareEqual(prev, m.value);
      if (Object.is(prev, next)) return;
      stores[m.store].set(m.key, next);
      relay(c, m.store, m.key, next);
      return;
    }
    case 'history': {
      c.lastSeq = m.seq;
      const present = presentDoc(m.present ?? {});
      if (m.op === 'record') {
        past.push(present);
        if (past.length > MAX_DEPTH) past = past.slice(past.length - MAX_DEPTH);
        future = [];
      } else if (m.op === 'undo') {
        const prev = past.pop();
        if (prev) { future.unshift(present); restore(prev); }
      } else if (m.op === 'redo') {
        const next = future.shift();
        if (next) {
          past.push(present);
          if (past.length > MAX_DEPTH) past = past.slice(past.length - MAX_DEPTH);
          restore(next);
        }
      } else if (m.op === 'reset') {
        past = []; future = [];
      }
      historyState();
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
