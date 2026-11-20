// THE EDITOR'S LINK TO THE SHOW HOST (E5/W3) — this window's stores, replicated into the authority.
//
// The Show Host (src/showhost/index.ts) is a utilityProcess holding the authoritative `doc` and
// `session` stores. This window keeps its own copies (state/docStore.ts) and stays a full replica:
// every write App makes lands here at once, exactly as in W1, and is forwarded to the host in order.
// Writes the host makes or relays (undo from W3b, a detached panel's edit from W5) come back as
// patches. The ordering rule that keeps both sides identical is written down in
// shared/showHostProtocol.ts; read it before changing anything below.
//
// ⚠ NO HOST IS A NORMAL STATE, NOT AN ERROR. Before the port arrives, while the host restarts, or for
// good after it gave up (main/showHost.ts), this window edits standalone, the frame engine reads these
// stores as always, and the show plays. On every (re)connect the editor hands the host its whole state,
// so the authority converges on what the operator sees.
//
// COST, BY CONSTRUCTION. A slice is sent at most once per task: writes mark the slice, a microtask sends
// the LATEST value of each marked slice. So a handler that writes `fixtures` five times sends it once,
// and a slice nobody writes sends nothing. Undo snapshots (W3b) flush first, so they never see a write
// that is still waiting in here. `window.__showHost.stats()` counts what was sent, per slice, so a
// harness can assert that nothing writes the document per frame.

import { docStore, sessionStore } from './docStore';
import { sliceDigest, type ClientToHost, type HostToClient, type Slices, type StoreName } from '../../../shared/showHostProtocol';
import type { DocStore } from '../../../shared/docStore';

const STORES: Record<StoreName, DocStore<Slices>> = {
  doc: docStore as unknown as DocStore<Slices>,
  session: sessionStore as unknown as DocStore<Slices>,
};

let port: MessagePort | null = null;
let connected = false;
let hostPid: number | null = null;
let seq = 0;
let applyingRemote = false;
const lastSent = new Map<string, number>();           // `${store}.${key}` → seq of its last send
const pending = new Map<string, [StoreName, string]>(); // slices written since the last flush
let flushQueued = false;
const sentCount = new Map<string, number>();
const unclonable = new Set<string>();                 // slices that failed to structured-clone (logged once)
let connects = 0;
const digestWaiters = new Map<number, (d: Record<string, string>) => void>();
let digestReq = 0;

function post(msg: ClientToHost): boolean {
  if (!port) return false;
  port.postMessage(msg);
  return true;
}

function sendSlice(store: StoreName, key: string): void {
  const id = `${store}.${key}`;
  const s = ++seq;
  try {
    post({ t: 'set', store, key, value: STORES[store].getSlice(key), seq: s });
  } catch (e) {
    // A slice holding something structured clone refuses (a function, a DOM node). The editor still
    // works — this slice simply is not replicated — and it is said once, by name, so it gets fixed.
    if (!unclonable.has(id)) { unclonable.add(id); console.warn(`[hostLink] ${id} cannot be sent to the Show Host:`, (e as Error).message); }
    return;
  }
  lastSent.set(id, s);
  sentCount.set(id, (sentCount.get(id) ?? 0) + 1);
}

/** Send every slice written since the last flush. Synchronous; also what a snapshot op calls first. */
export function flushToHost(): void {
  flushQueued = false;
  if (!connected) { pending.clear(); return; }   // the next connect sends the whole state anyway
  const batch = [...pending.values()];
  pending.clear();
  for (const [store, key] of batch) sendSlice(store, key);
}

function markWritten(store: StoreName, key: string): void {
  if (applyingRemote || !connected) return;
  pending.set(`${store}.${key}`, [store, key]);
  if (!flushQueued) { flushQueued = true; queueMicrotask(flushToHost); }
}

/** The full handover: every slice of both stores, in order, right after `hello`. */
function sendAll(): void {
  pending.clear();
  for (const store of ['doc', 'session'] as StoreName[]) {
    for (const key of Object.keys(STORES[store].get())) sendSlice(store, key);
  }
}

function onHostMessage(m: HostToClient): void {
  switch (m.t) {
    case 'welcome':
      hostPid = m.pid;
      console.log(`[hostLink] the Show Host is pid ${m.pid}`);
      return;
    case 'patch': {
      // Drop a patch for a slice this window has written since the host made it: the host will process
      // that newer write after the patch, and this window already shows it (shared/showHostProtocol.ts).
      if ((lastSent.get(`${m.store}.${m.key}`) ?? 0) > m.acked) return;
      applyingRemote = true;
      try { STORES[m.store].set(m.key, m.value); } finally { applyingRemote = false; }
      return;
    }
    case 'digest':
      digestWaiters.get(m.req)?.(m.digests);
      digestWaiters.delete(m.req);
      return;
  }
}

function attach(p: MessagePort): void {
  try { port?.close(); } catch { /* the old page's port */ }
  port = p;
  connects++;
  hostPid = null;            // unknown until THIS host's welcome; the old value names a dead process
  lastSent.clear();
  seq = 0;
  p.onmessage = (e: MessageEvent) => { try { onHostMessage(e.data as HostToClient); } catch (err) { console.error('[hostLink] host message failed:', err); } };
  p.start();
  connected = true;
  post({ t: 'hello', role: 'editor' });
  sendAll();
  console.log(`[hostLink] connected to the Show Host (connect #${connects})`);
}

// Watch every slice of both stores. A store's KEYS are fixed at creation (W1's INITIAL objects), so
// subscribing per key here covers every write App can make.
for (const store of ['doc', 'session'] as StoreName[]) {
  for (const key of Object.keys(STORES[store].get())) STORES[store].subscribeSlice(key, () => markWritten(store, key));
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { kind?: string } | undefined;
    if (data?.kind !== 'artlux:showhost-port') return;
    const p = e.ports[0];
    if (p) attach(p);
  });
  window.postMessage('artlux:showhost-ready', '*');

  // Diagnostics for harnesses (scripts/test-show-host.cjs). Read-only except `verify`, which only asks.
  (window as unknown as { __showHost: unknown }).__showHost = {
    connected: () => connected,
    pid: () => hostPid,
    connects: () => connects,
    stats: () => Object.fromEntries(sentCount),
    resetStats: () => sentCount.clear(),
    unclonable: () => [...unclonable],
    /** Ask the host for its digests and compare with this replica's. Resolves to the mismatching slices. */
    verify: (): Promise<{ mismatched: string[]; compared: number } | null> => new Promise((resolve) => {
      flushToHost();
      const req = ++digestReq;
      if (!post({ t: 'digest', req })) { resolve(null); return; }
      const timer = setTimeout(() => { digestWaiters.delete(req); resolve(null); }, 3000);
      digestWaiters.set(req, (host) => {
        clearTimeout(timer);
        const mismatched: string[] = [];
        let compared = 0;
        for (const store of ['doc', 'session'] as StoreName[]) {
          const all = STORES[store].get();
          for (const key of Object.keys(all)) {
            const id = `${store}.${key}`;
            if (unclonable.has(id)) continue;
            compared++;
            if (host[id] !== sliceDigest(all[key])) mismatched.push(id);
          }
        }
        resolve({ mismatched, compared });
      });
    }),
  };
}

/** Is a host there right now? */
export function hostConnected(): boolean { return connected; }
