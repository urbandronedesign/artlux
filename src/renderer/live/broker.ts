// THE ENGINE OWNER'S END OF EVERY LIVE CHANNEL (E5/W4). Runs in the editor window only — the one window
// that runs the frame engine, the transport and the thumbnail/peaks caches. A client window watches; this
// is the only place anything it watches is produced (plans/native-engine.md §9a, "one producer per datum").
// Wire format and the reasons for its shape: shared/liveProtocol.ts. Pairing: src/main/liveHub.ts.
//
// THE FOUR "NO DROP" RULES THIS FILE KEEPS (each is a verify:invariants check):
//   1. PULL, NEVER PUSH. A subscription is sent a sample only while it is `waiting` — set by `sub` and by
//      `pull`, cleared by the send. However fast a producer runs, a client receives at most one sample
//      per frame IT drew, and nothing at all while it is hidden (its rAF, which sends `pull`, is paused).
//   2. NOTHING RUNS FOR NOBODY. A stream's producer hook (`watch`) is attached when its first
//      subscription arrives and detached with its last. The clock's per-frame check is attached only
//      while some client asked for the clock. With no client connected this file costs nothing per frame.
//   3. THE CLOCK IS AN ANCHOR. It is sent when the transport stops agreeing with the last anchor (a seek,
//      a pause, a park, a wrap), never per frame.
//   4. A CLIENT'S HAND DIES WITH THE CLIENT. Every drag a client is holding is abandoned when main says
//      the client is gone, so a crashed panel window cannot leave an override pinning a channel.

import {
  type ClockAnchor, type LiveClientMsg, type LiveDrag, type LiveOwnerMsg,
  clockAt, CLOCK_TOLERANCE_SEC,
} from '../../../shared/liveProtocol';
import { timeline } from '../services/timeline';
import * as renderClock from '../engine/renderClock';
import { getThumb, hasExactThumb, onThumb } from '../services/thumbnailCache';
import { ensurePeaks, peaksFailed, peaksFor, sourceDurationFor, subscribePeaks } from '../components/timeline/audioPeaks';

// ── The stream registry ──────────────────────────────────────────────────────────────────────────

export interface LiveSample { value: unknown; transfer?: Transferable[] }

/**
 * A live stream: something that changes often and that a panel draws.
 * `watch` attaches to the producer and calls `onNew` whenever a new sample exists; it is attached only
 * while someone subscribes. `read` builds the sample for one subscription — it may COPY (the producer's
 * buffers are its own) and list what to transfer. Undefined = nothing to show yet.
 */
export interface LiveStream {
  watch(onNew: () => void): () => void;
  read(params: unknown): LiveSample | undefined;
}

/** How a client's drag lands. `abandon` = the client vanished mid-drag: put things back. */
export interface LiveDragTarget<D extends LiveDrag = LiveDrag> {
  move(d: D): void;
  end(d: D): void;
  abandon(d: D): void;
}

const streams = new Map<string, { s: LiveStream; gen: number; stop: (() => void) | null; subs: Set<Sub> }>();
// The editor's actions, set by App (E5/W5): a panel in another window edits by naming one of these.
type ActionRunner = (name: string, args: unknown[]) => unknown;
let runAction: ActionRunner | null = null;
/** App hands the broker its action facade. A name it does not have is refused, never guessed. */
export function setLiveActionRunner(fn: ActionRunner | null): void { runAction = fn; }
const dragTargets = new Map<LiveDrag['target'], LiveDragTarget>();

export function registerLiveStream(name: string, s: LiveStream): () => void {
  if (streams.has(name)) throw new Error(`[live] stream '${name}' registered twice`);
  streams.set(name, { s, gen: 0, stop: null, subs: new Set() });
  return () => {
    const e = streams.get(name);
    if (!e) return;
    for (const sub of e.subs) { sub.client.subs.delete(sub.id); post(sub.client, { t: 'gone', id: sub.id }); }
    e.stop?.();
    streams.delete(name);
  };
}

export function registerLiveDragTarget<T extends LiveDrag['target']>(
  target: T, h: LiveDragTarget<Extract<LiveDrag, { target: T }>>,
): () => void {
  dragTargets.set(target, h as LiveDragTarget);
  return () => { if (dragTargets.get(target) === (h as LiveDragTarget)) dragTargets.delete(target); };
}

// ── Clients ──────────────────────────────────────────────────────────────────────────────────────

interface Sub { client: Client; id: number; stream: string; params: unknown; waiting: boolean; sentGen: number }
interface Client {
  clientId: number;
  label: string;
  port: MessagePort;
  subs: Map<number, Sub>;
  clock: boolean;
  /** Drags in progress, by drag key → the last message (what `abandon` restores from). */
  held: Map<string, LiveDrag>;
  sent: Record<string, number>;
}
const clients = new Map<number, Client>();

function post(c: Client, msg: LiveOwnerMsg, transfer: Transferable[] = []): void {
  c.sent[msg.t] = (c.sent[msg.t] ?? 0) + 1;
  try { c.port.postMessage(msg, transfer); } catch (e) { console.warn('[live] post failed', (e as Error).message); }
}

function deliver(sub: Sub): void {
  if (!sub.waiting) return;                // rule 1: only a waiting subscription is ever sent anything
  const e = streams.get(sub.stream);
  if (!e) return;
  let sample: LiveSample | undefined;
  try { sample = e.s.read(sub.params); } catch (err) { console.warn(`[live] ${sub.stream} read failed`, err); return; }
  if (!sample) return;
  sub.waiting = false;
  sub.sentGen = e.gen;
  post(sub.client, { t: 'data', id: sub.id, value: sample.value, gen: e.gen }, sample.transfer ?? []);
}

function attach(name: string): void {
  const e = streams.get(name);
  if (!e || e.stop) return;
  e.stop = e.s.watch(() => {
    e.gen++;
    for (const sub of e.subs) deliver(sub);
  });
}
function detachIfIdle(name: string): void {
  const e = streams.get(name);
  if (!e || e.subs.size || !e.stop) return; // rule 2: the producer hook lives exactly as long as a sub
  e.stop();
  e.stop = null;
}

function dragKey(d: LiveDrag): string {
  return d.target === 'fixtureChannel' ? `${d.target}\u0000${d.fixtureId}\u0000${d.key}` : d.target;
}

function onDrag(c: Client, d: LiveDrag): void {
  const h = dragTargets.get(d.target);
  if (!h) return;
  const k = dragKey(d);
  try {
    if (d.end) { c.held.delete(k); h.end(d); }
    else { c.held.set(k, d); h.move(d); }
  } catch (e) { console.warn(`[live] drag ${d.target} failed`, e); }
}

const pendingAsks = new Set<() => void>();
/** Wait for `ready()` to hold, re-checking whenever `subscribe` says something landed. Bounded. */
function waitFor(subscribe: (cb: () => void) => () => void, ready: () => boolean, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ready()) { resolve(); return; }
    let unsub = () => {};
    const done = () => { clearTimeout(timer); unsub(); pendingAsks.delete(done); resolve(); };
    const timer = setTimeout(done, ms);
    unsub = subscribe(() => { if (ready()) done(); });
    pendingAsks.add(done);
  });
}
const ASK_TIMEOUT_MS = 15_000;

async function onThumbAsk(c: Client, req: number, path: string, time: number): Promise<void> {
  // getThumb() starts the exact decode and returns the nearest frame it already has. Answer with the
  // exact frame once it lands; with the nearest one if it never does.
  getThumb(path, time);
  await waitFor((cb) => onThumb((p) => { if (p === path) cb(); }), () => hasExactThumb(path, time), ASK_TIMEOUT_MS);
  const bmp = getThumb(path, time);
  // A COPY: transferring the cache's own bitmap would detach it from every filmstrip in this window.
  const copy = bmp ? await createImageBitmap(bmp).catch(() => null) : null;
  if (!clients.has(c.clientId)) { copy?.close(); return; }
  post(c, { t: 'thumb', req, bitmap: copy }, copy ? [copy] : []);
}

async function onPeaksAsk(c: Client, req: number, path: string, buckets: number): Promise<void> {
  ensurePeaks(path);
  await waitFor(subscribePeaks, () => !!peaksFor(path, 1) || peaksFailed(path), ASK_TIMEOUT_MS);
  const p = peaksFor(path, Math.max(1, buckets | 0));
  const copy = p ? p.slice() : null;      // peaksFor may hand back the cache's own array
  if (!clients.has(c.clientId)) return;
  post(c, { t: 'peaks', req, peaks: copy, duration: sourceDurationFor(path) }, copy ? [copy.buffer] : []);
}

async function onAction(c: Client, req: number, name: string, args: unknown[]): Promise<void> {
  let value: unknown;
  let error: string | undefined;
  try {
    if (!runAction) throw new Error('the editor is not ready');
    value = await runAction(name, args);
  } catch (e) { error = (e as Error)?.message ?? String(e); }
  if (!clients.has(c.clientId)) return;
  // A return value that does not clone (a function, a DOM node) is dropped, not an error: the action ran.
  try { c.port.postMessage({ t: 'actionResult', req, value, error } satisfies LiveOwnerMsg); c.sent.actionResult = (c.sent.actionResult ?? 0) + 1; }
  catch { post(c, { t: 'actionResult', req, error }); }
}

function onMessage(c: Client, m: LiveClientMsg): void {
  switch (m.t) {
    case 'hello': c.label = String(m.label ?? c.label); return;
    case 'sub': {
      const e = streams.get(m.stream);
      if (!e) { post(c, { t: 'gone', id: m.id }); return; }
      const old = c.subs.get(m.id);
      if (old) streams.get(old.stream)?.subs.delete(old);
      const sub: Sub = { client: c, id: m.id, stream: m.stream, params: m.params, waiting: true, sentGen: -1 };
      c.subs.set(m.id, sub);
      e.subs.add(sub);
      attach(m.stream);
      deliver(sub);                         // the current sample at once, if the stream has one
      return;
    }
    case 'unsub': {
      const sub = c.subs.get(m.id);
      if (!sub) return;
      c.subs.delete(m.id);
      streams.get(sub.stream)?.subs.delete(sub);
      detachIfIdle(sub.stream);
      return;
    }
    case 'pull': {
      const sub = c.subs.get(m.id);
      if (!sub) return;
      sub.waiting = true;
      // A sample produced while this client was still drawing the last one is sent now; otherwise the
      // next one the producer makes is.
      if (streams.get(sub.stream)!.gen !== sub.sentGen) deliver(sub);
      return;
    }
    case 'clock':
      c.clock = !!m.on;
      if (c.clock && anchor) post(c, { t: 'clock', anchor });
      syncClockWatch();
      return;
    case 'thumb': void onThumbAsk(c, m.req, String(m.path), Number(m.time) || 0); return;
    case 'peaks': void onPeaksAsk(c, m.req, String(m.path), Number(m.buckets) || 0); return;
    case 'drag': onDrag(c, m); return;
    case 'action': void onAction(c, m.req, String(m.name), Array.isArray(m.args) ? m.args : []); return;
  }
}

function addClient(clientId: number, label: string, port: MessagePort): void {
  removeClient(clientId); // a reload re-pairs under the same id; the old port is dead
  const c: Client = { clientId, label, port, subs: new Map(), clock: false, held: new Map(), sent: {} };
  clients.set(clientId, c);
  port.onmessage = (e) => { const m = e.data as LiveClientMsg; if (m && typeof m === 'object') onMessage(c, m); };
  post(c, { t: 'welcome', clientId, streams: [...streams.keys()] });
}

function removeClient(clientId: number): void {
  const c = clients.get(clientId);
  if (!c) return;
  clients.delete(clientId);
  // Rule 4: release every hand this client had on the show.
  for (const d of c.held.values()) {
    try { dragTargets.get(d.target)?.abandon(d); } catch (e) { console.warn('[live] abandon failed', e); }
  }
  c.held.clear();
  for (const sub of c.subs.values()) { streams.get(sub.stream)?.subs.delete(sub); detachIfIdle(sub.stream); }
  c.subs.clear();
  try { c.port.close(); } catch { /* gone with its window */ }
  syncClockWatch();
}

// ── The clock anchor ─────────────────────────────────────────────────────────────────────────────

let anchor: ClockAnchor | null = null;
let rev = 0;
let clockStop: (() => void) | null = null;
let prevPlayhead = NaN;
let prevShow = NaN;
let lastOfflineSend = 0;
const OFFLINE_ANCHOR_MS = 100;

/** The transport as of the frame just computed, as an anchor (not yet compared with the last one). */
function sampleClock(): ClockAnchor {
  const playing = timeline.isPlaying();
  const playhead = timeline.getPlayhead();
  const showTime = timeline.getShowTime();
  // Rate = did this clock move since the last frame. Not `playing`: a playing transport parks at the
  // end of a non-looping scene, and its show clock may still run.
  const playheadRate: 0 | 1 = playing && playhead !== prevPlayhead ? 1 : 0;
  const showRate: 0 | 1 = playing && showTime !== prevShow ? 1 : 0;
  prevPlayhead = playhead;
  prevShow = showTime;
  // Stamped with the FRAME's time, not now: the frame's own work time would otherwise read as drift.
  return {
    playhead, showTime, playing, playheadRate, showRate,
    at: performance.timeOrigin + timeline.getFrameTimeMs(),
    offline: renderClock.isOffline(), rev: 0,
  };
}

function agrees(a: ClockAnchor, b: ClockAnchor): boolean {
  if (a.playing !== b.playing || a.offline !== b.offline) return false;
  if (a.playheadRate !== b.playheadRate || a.showRate !== b.showRate) return false;
  const p = clockAt(a, b.at);
  return Math.abs(p.playhead - b.playhead) <= CLOCK_TOLERANCE_SEC
    && Math.abs(p.showTime - b.showTime) <= CLOCK_TOLERANCE_SEC;
}

function checkClock(): void {
  const next = sampleClock();
  if (anchor && agrees(anchor, next)) return; // rule 3: agreement = silence
  if (next.offline) {
    // A bake moves the clock every rendered frame by design. A window watching it needs to see it
    // move, not to receive a message per baked frame.
    const now = performance.now();
    if (now - lastOfflineSend < OFFLINE_ANCHOR_MS) return;
    lastOfflineSend = now;
  }
  anchor = { ...next, rev: ++rev };
  for (const c of clients.values()) if (c.clock) post(c, { t: 'clock', anchor });
}

function syncClockWatch(): void {
  const wanted = [...clients.values()].some((c) => c.clock);
  if (wanted && !clockStop) {
    prevPlayhead = NaN; prevShow = NaN;
    anchor = null;
    const off = timeline.subscribe(() => checkClock()); // runs after each transport frame
    clockStop = off;
    checkClock();
  } else if (!wanted && clockStop) {
    clockStop();
    clockStop = null;
  }
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────────

let started = false;
/** Start listening for client ports. The editor window only; idempotent. */
export function startLiveBroker(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('message', (e) => {
    const d = e.data as { kind?: string; payload?: { role?: string; clientId?: number; label?: string } } | null;
    if (!d || d.kind !== 'artlux:live-port') return;
    const p = d.payload ?? {};
    if (p.role === 'owner' && e.ports[0] && typeof p.clientId === 'number') addClient(p.clientId, String(p.label ?? 'window'), e.ports[0]);
    else if (p.role === 'drop' && typeof p.clientId === 'number') removeClient(p.clientId);
  });
  window.postMessage('artlux:live-ready', '*');

  // Diagnostics for the harness (scripts/test-live-channel.cjs): what each client was sent, and what
  // is attached. Same window-guarded pattern as __showHost.
  (window as unknown as { __liveBroker?: unknown }).__liveBroker = {
    clients: () => [...clients.values()].map((c) => ({
      clientId: c.clientId, label: c.label, clock: c.clock, subs: c.subs.size, held: [...c.held.keys()], sent: { ...c.sent },
    })),
    attached: () => [...streams.entries()].filter(([, e]) => e.stop).map(([k]) => k),
    streams: () => [...streams.keys()],
    clockWatching: () => !!clockStop,
    anchor: () => anchor,
    resetSent: () => { for (const c of clients.values()) c.sent = {}; },
    pendingAsks: () => pendingAsks.size,
    // The owner's own clock at the frame just computed, for comparing with a client's extrapolation.
    truth: () => ({ playhead: timeline.getPlayhead(), showTime: timeline.getShowTime(), playing: timeline.isPlaying(), at: performance.timeOrigin + timeline.getFrameTimeMs() }),
  };
}
