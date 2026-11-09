import type { OscMessage } from '../../../shared/protocol';
import type { OscSender } from '../types';

// ── THE STATE MACHINE'S OSC INBOX ────────────────────────────────────────────────────────────────
//
// External devices (a TouchOSC tablet, an Arduino, a LiDAR box, a show PC) drive the state machine by
// sending an OSC address. Two bindings consume this:
//   · an `osc` TRIGGER on a transition (SmTrigger.oscAddress/oscSender) — evaluated by fsm.tick(), so
//     every guard an automatic trigger obeys (requireEnd, waitForContent, lock time) still applies;
//   · an OSC JUMP on a state (SmState.osc) — handled in oscController, through requestEnter().
//
// WHY AN INBOX AND NOT A DIRECT CALL. Messages arrive on IPC between frames; the FSM evaluates once per
// frame. The inbox turns a message into a ONE-FRAME PULSE: pushed now, asked by the next tick, then
// DRAINED (timeline.ts, right after the tick — armed or not). Without the drain a message that matched
// nothing — sent while the show was in a state with no such edge — would sit here and fire minutes
// later, the moment the show happened to reach a state that has one. That is a ghost GO.
//
// AND AN AGE CAP on top of the drain: the frame loop is a rAF, and a rAF stops when the window is
// hidden/occluded. A message that arrived during that pause would otherwise fire whenever painting
// resumed. Anything older than MAX_AGE_MS is not a trigger any more, it is history.
//
// Pure module: no React, no engine import. timeline.ts asks `hit()` through SmContext.oscHit so
// stateMachine.ts keeps importing nothing but types.

const MAX_AGE_MS = 500;
const MAX_PENDING = 256; // a flood (a fader streaming to a bound address) must not grow without bound

interface Pending { address: string; from?: { host: string; port: number }; at: number }

let pending: Pending[] = [];
let senders: OscSender[] = [];

// ── addresses + press semantics ───────────────────────────────────────────────────────────────────

/** Bindings are typed by hand; tolerate a missing leading slash and stray whitespace. Case is kept. */
export function normalizeAddress(a: string | undefined | null): string {
  const t = (a ?? '').trim();
  if (!t) return '';
  return t.startsWith('/') ? t : '/' + t;
}

// A PRESS, not a release. A TouchOSC/Open Stage Control button sends `1` on press and `0` on release —
// both to the same address. Firing on both would take TWO transitions per tap (or re-enter a state
// twice). So: no args (a bare trigger), a string, or a non-zero number fires; `0` does not.
export function isPress(args: (number | string)[]): boolean {
  if (!args || args.length === 0) return true;
  const a = args[0];
  return typeof a === 'string' ? true : a !== 0;
}

// ── senders ───────────────────────────────────────────────────────────────────────────────────────

/** Fed from AppSettings.oscSenders by App whenever the settings change. */
export function setSenders(list: OscSender[] | undefined): void {
  senders = Array.isArray(list) ? list : [];
  notify();
}
export function getSenders(): OscSender[] { return senders; }

/**
 * Resolve a binding's sender NAME. `''`/absent ⇒ 'any'. A name this machine has no entry for ⇒
 * 'missing' — and a missing sender is INERT: a project from the build PC must not start obeying every
 * device on the venue network because nobody created the "Tablet" entry there yet.
 */
export function resolveSender(name: string | undefined): OscSender | 'any' | 'missing' {
  if (!name) return 'any';
  return senders.find(s => s.name === name) ?? 'missing';
}

function fromMatches(from: { host: string; port: number } | undefined, s: OscSender | 'any'): boolean {
  if (s === 'any') return true;
  // No `from` = an unknown sender (a synthetic message). Unknown is not "the tablet".
  if (!from) return false;
  if (from.host !== s.host.trim()) return false;
  return !s.port || from.port === s.port;
}

/** Does a message from `from` to `address` satisfy a binding of (bindAddress, senderName)? */
export function matches(address: string, from: OscMessage['from'], bindAddress: string | undefined, senderName: string | undefined): boolean {
  const want = normalizeAddress(bindAddress);
  if (!want || address !== want) return false;
  const s = resolveSender(senderName);
  return s !== 'missing' && fromMatches(from, s);
}

// ── the inbox ─────────────────────────────────────────────────────────────────────────────────────

/** Every incoming OSC message passes through here (oscController.route). Cheap: LiDAR streams at 60fps. */
export function push(msg: OscMessage): void {
  const now = performance.now();
  noteSource(msg, now);
  if (!isPress(msg.args)) { noteAddress(msg.address, now); return; }
  if (learner && !streamingAt(msg.address, learnArmedAt)) { const l = learner; learner = null; l(msg); }
  noteAddress(msg.address, now);
  if (pending.length >= MAX_PENDING) pending.shift();
  pending.push({ address: msg.address, from: msg.from, at: now });
}

/** SmContext.oscHit — did a matching press arrive since the last drain? Read-only: a message may fire
 *  several transitions only in the sense the FSM already allows (it takes at most one per frame). */
export function hit(bindAddress: string | undefined, senderName: string | undefined): boolean {
  if (!pending.length) return false;
  const cutoff = performance.now() - MAX_AGE_MS;
  for (const p of pending) {
    if (p.at < cutoff) continue;
    if (matches(p.address, p.from, bindAddress, senderName)) return true;
  }
  return false;
}

/** Called once per frame right after fsm.tick() — see the module note on ghost GOs. */
export function drain(): void { if (pending.length) pending = []; }

// ── LEARN — "press the button on the device now" fills a binding's address and sender ───────────────
//
// The listener is shared with LiDAR / Augmenta, which STREAM their own addresses dozens of times a
// second; a naive "take the next message" would learn a blob coordinate every time. So an address
// that was already arriving in the second before Learn was armed is a stream, not a press, and is
// skipped. The operator presses after arming; that press is new traffic.

let learner: ((msg: OscMessage) => void) | null = null;
let learnArmedAt = 0;
const lastByAddress = new Map<string, number>();
function noteAddress(address: string, now: number): void {
  if (lastByAddress.size > 512) lastByAddress.clear(); // unbounded address schemes must not leak
  lastByAddress.set(address, now);
}
function streamingAt(address: string, armedAt: number): boolean {
  const t = lastByAddress.get(address);
  return t != null && t < armedAt && armedAt - t < 1000;
}

/** Arm a one-shot learn. Returns a cancel. Arming again replaces the previous learner. */
export function learn(cb: (msg: OscMessage) => void): () => void {
  learnArmedAt = performance.now();
  learner = cb;
  return () => { if (learner === cb) learner = null; };
}

/** The configured sender a message came from, if any — exact port first, then a host-only entry. */
export function senderNameFor(from: OscMessage['from']): string | undefined {
  if (!from) return undefined;
  const exact = senders.find(s => s.host.trim() === from.host && s.port && s.port === from.port);
  if (exact) return exact.name;
  return senders.find(s => s.host.trim() === from.host && !s.port)?.name;
}

// ── "seen recently" — for Preferences, so an operator copies the real IP:port instead of guessing ──

export interface SeenSource { host: string; port: number; lastAddress: string; at: number }
const seen = new Map<string, SeenSource>();
const SEEN_MAX = 24;

function noteSource(msg: OscMessage, now: number): void {
  if (!msg.from) return;
  const key = `${msg.from.host}:${msg.from.port}`;
  const prev = seen.get(key);
  if (prev) { prev.lastAddress = msg.address; prev.at = now; }
  else {
    seen.set(key, { host: msg.from.host, port: msg.from.port, lastAddress: msg.address, at: now });
    // Evict the stalest — ephemeral-port senders mint a new key per app restart.
    if (seen.size > SEEN_MAX) {
      let oldK = ''; let oldAt = Infinity;
      for (const [k, v] of seen) if (v.at < oldAt) { oldAt = v.at; oldK = k; }
      seen.delete(oldK);
    }
  }
  scheduleNotify();
}

/** Most recent first. */
export function getSeenSources(): SeenSource[] {
  return [...seen.values()].sort((a, b) => b.at - a.at);
}

// ── change notification (UI) — throttled: a 60fps LiDAR stream must not re-render Preferences 60×/s ──

const subs = new Set<() => void>();
let version = 0;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
function notify(): void { version++; subs.forEach(cb => cb()); }
function scheduleNotify(): void {
  if (notifyTimer || subs.size === 0) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; notify(); }, 500);
}
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
/** For useSyncExternalStore — bumps on sender edits and (throttled) on new traffic. */
export function getVersion(): number { return version; }
