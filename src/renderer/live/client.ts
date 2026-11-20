// A WINDOW'S END OF THE LIVE CHANNEL (E5/W4): how a panel outside the editor watches live data, reads the
// clock, asks for thumbnails and peaks, and drags a slider in the engine owner. Wire format:
// shared/liveProtocol.ts. The other end: renderer/live/broker.ts.
//
// THIS FILE PRODUCES NOTHING. It does not decode, composite, sample or run a transport — the owner does,
// once, for every window (plans/native-engine.md §9a). A panel window that imported a producer to "save
// a round trip" would be exactly the duplicated work the rule exists to forbid.
//
// THE PULL. A subscription's callback gets one sample; the `pull` for the next one is sent from this
// window's next animation frame. So the rate is this window's refresh (whatever the display runs at —
// there is no cap here), a minimised or hidden window stops pulling because its rAF stops, and a slow
// panel slows only itself.

import { type ClockAnchor, type LiveClientMsg, type LiveDrag, type LiveOwnerMsg, clockAt, wallNow } from '../../../shared/liveProtocol';

interface ClientSub { stream: string; params: unknown; cb: (value: unknown) => void }
interface Ask { msg: LiveClientMsg; resolve: (m: LiveOwnerMsg | null) => void }

let port: MessagePort | null = null;
let clientId: number | null = null;
let label = 'window';
let connecting = false;
let nextId = 1;
let nextReq = 1;
const subs = new Map<number, ClientSub>();
const asks = new Map<number, Ask>();
let clockWatchers = 0;
let anchor: ClockAnchor | null = null;
const clockSubs = new Set<(a: ClockAnchor) => void>();
const received: Record<string, number> = {};
let streamsOffered: string[] = [];

function send(m: LiveClientMsg): void {
  if (!port) return; // replayed on connect (subs, clock, asks); a drag before connect is meaningless
  try { port.postMessage(m); } catch { /* the owner went away; a new port is coming */ }
}

// One rAF per frame, however many subscriptions want a pull.
const toPull = new Set<number>();
let rafPending = false;
// A harness switch (scripts/test-live-channel.cjs): stop pulling, as a window whose rAF is paused does,
// to prove the owner then sends nothing more. Never set by app code.
let pullsHeld = false;
function schedulePull(id: number): void {
  toPull.add(id);
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    if (pullsHeld) return;                 // harness only: the ids stay queued until released
    for (const i of toPull) if (subs.has(i)) send({ t: 'pull', id: i });
    toPull.clear();
  });
}

function onMessage(m: LiveOwnerMsg): void {
  received[m.t] = (received[m.t] ?? 0) + 1;
  switch (m.t) {
    case 'welcome': clientId = m.clientId; streamsOffered = m.streams; return;
    case 'data': {
      const s = subs.get(m.id);
      if (!s) return;
      try { s.cb(m.value); } catch (e) { console.warn(`[live] ${s.stream} subscriber threw`, e); }
      schedulePull(m.id);
      return;
    }
    case 'gone': subs.delete(m.id); return;
    case 'clock':
      anchor = m.anchor;
      for (const cb of clockSubs) { try { cb(m.anchor); } catch { /* one bad listener only */ } }
      return;
    case 'thumb': case 'peaks': {
      const a = asks.get(m.req);
      if (!a) { if (m.t === 'thumb') m.bitmap?.close(); return; }
      asks.delete(m.req);
      a.resolve(m);
      return;
    }
  }
}

function attach(p: MessagePort, id: number): void {
  try { port?.close(); } catch { /* already dead */ }
  port = p;
  clientId = id;
  connecting = false;
  p.onmessage = (e) => onMessage(e.data as LiveOwnerMsg);
  // Replay everything this window wants: a fresh port is a fresh owner page, which knows nothing.
  send({ t: 'hello', label });
  for (const [sid, s] of subs) send({ t: 'sub', id: sid, stream: s.stream, params: s.params });
  if (clockWatchers > 0) send({ t: 'clock', on: true });
  for (const a of asks.values()) send(a.msg);
}

let listening = false;
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('message', (e) => {
    const d = e.data as { kind?: string; payload?: { role?: string; clientId?: number } } | null;
    if (!d || d.kind !== 'artlux:live-port' || d.payload?.role !== 'client' || !e.ports[0]) return;
    attach(e.ports[0], Number(d.payload.clientId));
  });
  window.postMessage('artlux:live-ready', '*');
}

export const liveClient = {
  /** Pair this window with the engine owner. Idempotent; a reload of either side re-pairs by itself. */
  connect(asLabel = 'window'): void {
    label = asLabel;
    listen();
    if (port || connecting) return;
    connecting = true;
    window.artlux?.liveConnect(asLabel);
  },
  connected(): boolean { return !!port; },

  /**
   * Watch a stream. `cb` receives each sample; the next is pulled on this window's next frame.
   * Call the returned function when the panel is hidden or unmounted — that is what stops the traffic.
   */
  subscribe(stream: string, params: unknown, cb: (value: unknown) => void): () => void {
    const id = nextId++;
    subs.set(id, { stream, params, cb });
    send({ t: 'sub', id, stream, params });
    return () => {
      if (!subs.delete(id)) return;
      toPull.delete(id);
      send({ t: 'unsub', id });
    };
  },

  /** Ask for clock anchors (ref-counted: the last release turns them off). */
  watchClock(cb?: (a: ClockAnchor) => void): () => void {
    if (cb) clockSubs.add(cb);
    if (clockWatchers++ === 0) send({ t: 'clock', on: true });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (cb) clockSubs.delete(cb);
      if (--clockWatchers === 0) { send({ t: 'clock', on: false }); }
    };
  },
  /** The last anchor, or null before the first. */
  anchor(): ClockAnchor | null { return anchor; },
  /** Both clocks NOW, computed in this window from the last anchor — no message per frame. */
  now(): { playhead: number; showTime: number; playing: boolean } | null {
    if (!anchor) return null;
    return { ...clockAt(anchor, wallNow()), playing: anchor.playing };
  },

  /** A thumbnail from the owner's cache (decoded there, once). Null = nothing to show. */
  thumb(path: string, time: number): Promise<ImageBitmap | null> {
    const req = nextReq++;
    const msg: LiveClientMsg = { t: 'thumb', req, path, time };
    return new Promise((resolve) => {
      asks.set(req, { msg, resolve: (m) => resolve(m && m.t === 'thumb' ? m.bitmap : null) });
      send(msg);
    });
  },
  /** Waveform peaks from the owner's decode. */
  peaks(path: string, buckets: number): Promise<{ peaks: Float32Array | null; duration: number | null }> {
    const req = nextReq++;
    const msg: LiveClientMsg = { t: 'peaks', req, path, buckets };
    return new Promise((resolve) => {
      asks.set(req, { msg, resolve: (m) => resolve(m && m.t === 'peaks' ? { peaks: m.peaks, duration: m.duration } : { peaks: null, duration: null }) });
      send(msg);
    });
  },

  /** A slider in this window driving the owner's render-free channel. Send `end: true` on release. */
  drag(d: LiveDrag): void { send({ t: 'drag', ...d }); },
};

if (typeof window !== 'undefined') {
  (window as unknown as { __liveClient?: unknown }).__liveClient = {
    ...liveClient,
    id: () => clientId,
    received: () => ({ ...received }),
    resetReceived: () => { for (const k of Object.keys(received)) delete received[k]; },
    streams: () => streamsOffered,
    subs: () => subs.size,
    holdPulls: (on: boolean) => {
      pullsHeld = !!on;
      if (!pullsHeld && toPull.size) { const ids = [...toPull]; toPull.clear(); for (const i of ids) schedulePull(i); }
    },
  };
}
