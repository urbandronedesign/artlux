import { StateMachine, SmState, SmTransition, SmAction, Marker } from '../types';

// Finite-state-machine runtime for the project-level "Show" graph over scenes. Pure-ish module
// singleton driven once per frame by the engine (services/timeline.ts), main window only. It never
// touches the transport directly — it emits TransportIntents which App turns into React state so App
// stays the single writer of `playing` (see App's subscribeIntent). Scenes are recalled via
// ctx.recallScene (routed through cueBus to App). Current-state + elapsed are exposed render-free via
// subscribeState / getStateElapsedSec for the lane and the main-UI status chip.
//
// Clock: `afterDelay` runs off a standalone wall clock (ctx.nowSec) so it advances even when the
// timeline transport is stopped; `atTime`/`onMarker`/`onClipEnd` use the timeline playhead and only
// fire when it advances. `onTimelineEnd` is the odd one out: every other playhead trigger is a
// CROSSING, and a clean stop at the end crosses nothing — so the engine hands it to us as a
// one-frame edge (ctx.atEnd) instead of a time we could test. `ctx.held` is the same event as a
// LEVEL — the state's timeline is parked on its last frame while the show plays on — and is what
// SmTransition.requireEnd waits on.

export type TransportIntent =
  | { kind: 'play' }
  | { kind: 'pause' }
  | { kind: 'stop' }
  | { kind: 'seek'; sec: number }
  | { kind: 'loop'; loopOn: boolean };

export interface SmContext {
  markers: Marker[];
  clipActive: (layerId: string, t: number) => boolean; // is a clip under the playhead on this layer?
  emit: (i: TransportIntent) => void;
  recallScene: (sceneId: string, fadeSec?: number) => void; // recall a Scene by id (fade overrides default)
  fireCue: (cueId: string) => void;       // fire a granular Cue by id (routed via cueBus to App)
  nowSec: number;                          // monotonic wall clock (seconds) — drives afterDelay
  atEnd: boolean;                          // the timeline reached its end THIS frame (see 'onTimelineEnd')
  // THE STATE'S PICTURE IS OVER AND THE SHOW IS STILL RUNNING — the bound timeline is parked on its
  // last frame with the transport alive (Timeline.holdAtEnd). Unlike `atEnd` this is a LEVEL, not a
  // one-frame edge: it stays true for as long as the hold lasts, which is what lets a transition WAIT
  // on it (SmTransition.requireEnd) rather than having to catch a single frame.
  held: boolean;
  /**
   * Is the look bound to `sceneId` decoded enough to cut to — i.e. would promoting its pool put a
   * PICTURE on stage rather than black? For `SmTransition.waitForContent`; see the guard below.
   *
   * Cheap and side-effect-free from this module's point of view (the engine's implementation also
   * re-drives the pre-roll, exactly as the boot gate's polling does).
   */
  contentReady: (sceneId: string) => boolean;
  // PLUGIN-OWNED TRIGGERS ('plugin' kind). The FSM asks; it never knows what it is asking about.
  //
  // Passed as a FUNCTION rather than the registry itself, so this module keeps importing nothing but
  // types — it is the piece of the app most worth being able to reason about in isolation, and a
  // registry import would drag the whole contribution graph (and every plugin) into it. The engine
  // (services/timeline.ts) closes over the real registry when it builds the context.
  //
  // Contract for an implementor: cheap, side-effect-free, and EDGE-shaped where that matters — see
  // `stateEnteredAtSec`, which is how a source distinguishes "someone just walked in" from "someone
  // is standing here", the difference between a show that advances once and one that never settles.
  pluginTrigger: (source: string, params: Record<string, unknown>, stateEnteredAtSec: number) => boolean;
}

let currentStateId: string | null = null;
let stateEnteredAt = 0;     // playhead seconds when the current state was entered
let stateEnteredAtWall = 0; // wall-clock seconds when the current state was entered (standalone clock)
let lastNowSec = 0;         // most recent ctx.nowSec seen by tick() — for getStateElapsedSec()
let lastEnabled = false;    // for rising-edge (re)initialization
let forcedId: string | null = null; // external "go to this state" request, applied on the next tick
// Wall-clock second at which the CURRENT state's hold began (ctx.held's rising edge), or null when the
// state is not held. Drives StateMachine.idleResetSec — the unattended "reached its end, nobody came,
// go home" reset. Kept here (not derived from stateEnteredAtWall) precisely because the timer must
// start when the picture FINISHED, not when the state was entered. Cleared on every enter().
let heldSinceWall: number | null = null;
const stateSubs = new Set<(id: string | null) => void>();
const firedSubs = new Set<(transitionId: string) => void>();

const notify = (): void => { stateSubs.forEach(cb => cb(currentStateId)); };

// Subscribe to current-state changes (fires immediately with the current value).
export function subscribeState(cb: (id: string | null) => void): () => void {
  stateSubs.add(cb); cb(currentStateId); return () => { stateSubs.delete(cb); };
}
// Subscribe to "a transition just fired" events (for active-edge pulse in the editor).
export function subscribeFired(cb: (transitionId: string) => void): () => void {
  firedSubs.add(cb); return () => { firedSubs.delete(cb); };
}
export function getCurrentStateId(): string | null { return currentStateId; }
// Queue an external "force-enter this state" request (UI double-click / future OSC/MIDI triggers).
// Applied on the next tick once the machine is enabled, taking precedence over the rising-edge re-init
// so it survives the React→engine enable-propagation delay. No-op target is harmless (ignored if gone).
export function requestEnter(stateId: string): void { forcedId = stateId; }
// Seconds spent in the current state on the standalone wall clock (0 when no state).
export function getStateElapsedSec(): number {
  return currentStateId == null ? 0 : Math.max(0, lastNowSec - stateEnteredAtWall);
}

function runEntry(actions: SmAction[], ctx: SmContext): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'play': ctx.emit({ kind: 'play' }); break;
      case 'pause': ctx.emit({ kind: 'pause' }); break;
      case 'stop': ctx.emit({ kind: 'stop' }); break;
      case 'seek': ctx.emit({ kind: 'seek', sec: a.seekTo ?? 0 }); break;
      case 'setLoop': ctx.emit({ kind: 'loop', loopOn: !!a.loopOn }); break;
      case 'jumpMarker': { const m = ctx.markers.find(mk => mk.id === a.markerId); if (m) ctx.emit({ kind: 'seek', sec: m.time }); break; }
      case 'recallScene': if (a.sceneId) ctx.recallScene(a.sceneId); break;
      case 'fireCue': if (a.cueId) ctx.fireCue(a.cueId); break;
    }
  }
}

// Enter a state: recall its bound scene (with the arriving transition's fade, if any), run its entry
// actions, then notify. `via` is the transition we arrived through (null on (re)initialization).
function enter(sm: StateMachine, stateId: string, playhead: number, ctx: SmContext, via: SmTransition | null): void {
  currentStateId = stateId;
  stateEnteredAt = playhead;
  stateEnteredAtWall = ctx.nowSec;
  heldSinceWall = null; // a fresh state has not reached its end yet — the idle-reset clock restarts on hold
  const s = sm.states.find(st => st.id === stateId);
  if (s?.sceneId) ctx.recallScene(s.sceneId, via?.fadeSec); // 1:1 scene binding — crossfade over the transition time
  if (s) runEntry(s.entry, ctx);
  if (via) firedSubs.forEach(cb => cb(via.id));
  notify();
}

// THE `requireEnd` GUARD — "not until this state's picture has finished".
//
// It is not a trigger: the trigger still has to fire, this only decides whether it MAY. It exists for
// the AUTOMATIC path, where the thing about to cut a twenty-second film three seconds in is a visitor
// who wandered into a trigger zone — something nobody chose and nobody can see coming.
//
// ⚠ IT DOES NOT BIND A HUMAN. triggerManual() — the state-lane button, Ctrl+click on an edge, OSC, the
// show-control tablet — fires regardless. An operator reaching for a button during a show has a reason
// the machine does not have access to (the room emptied, the artist walked off, the fire alarm), and a
// control that silently refuses is worse than a cut: they press it again, harder, while nothing
// happens. The UI marks such a button as early instead, so the consequence is visible and the decision
// stays theirs. (`requestEnter()` remains the bypass that skips the graph entirely.)
//
// A state whose timeline does NOT hold (it loops, or it has no holdAtEnd) never satisfies this — which
// is exactly what the author asked for, and why the editor only offers the checkbox as an explicit
// opt-in rather than defaulting it on.
const gated = (tr: SmTransition, ctx: SmContext): boolean => !!tr.requireEnd && !ctx.held;

// ── `waitForContent` — HOLD A CUT UNTIL THE DESTINATION HAS A PICTURE ────────────────────────────
//
// OFF BY DEFAULT, AND THAT DEFAULT IS THE DESIGN. A GO is an operator's hand in front of an audience:
// a cut that silently refuses to happen reads as a broken button, so they press it again while
// nothing moves. Failing fast — cutting to whatever is decoded — is the right behaviour for a manned
// show, and it is what the cold-start gate deliberately does NOT do only because at project open
// nobody is watching yet.
//
// The case this exists for is the other one: an unattended installation, no operator, where 400 ms of
// waiting is plainly better than a black frame in front of a visitor. So it is per-transition and
// opt-in — the author says which cuts are worth waiting for.
//
// ⚠ AND IT IS CAPPED, because an uncapped wait is a hang. A destination that never becomes ready (a
// missing file, a live source that never arrives) would otherwise freeze the machine on that edge
// forever, unattended, with nothing in the log. After WAIT_CONTENT_CAP_MS the transition fires
// anyway — the same fail-open promise the boot gate makes.
const WAIT_CONTENT_CAP_MS = 1000;
const waitingSince = new Map<string, number>(); // transition id → when it first waited on content

function contentGated(tr: SmTransition, toSceneId: string | undefined, ctx: SmContext): boolean {
  if (!tr.waitForContent || !toSceneId) return false;
  if (ctx.contentReady(toSceneId)) { waitingSince.delete(tr.id); return false; }
  const nowMs = ctx.nowSec * 1000;
  const since = waitingSince.get(tr.id);
  if (since === undefined) { waitingSince.set(tr.id, nowMs); return true; }
  if (nowMs - since < WAIT_CONTENT_CAP_MS) return true;
  // Deadline: fire on black rather than freeze the show here. Say so once per transition.
  console.warn(`[sm] "${tr.id}" waited ${WAIT_CONTENT_CAP_MS}ms for its destination's content and cut anyway`);
  waitingSince.delete(tr.id);
  return false;
}

// Crossing test for an absolute time T over the prev→cur playhead window (handles loop/backward
// wrap when cur < prev: the window covers prev→end and start→cur).
function crossed(T: number, prev: number, cur: number): boolean {
  if (cur >= prev) return T > prev && T <= cur;
  return T > prev || T <= cur;
}

function triggerFires(tr: SmTransition, fromState: SmState | undefined, playhead: number, prev: number, ctx: SmContext): boolean {
  const g = tr.trigger;
  switch (g.kind) {
    case 'manual': return false; // only via triggerManual()
    case 'afterDelay': {
      // Standalone wall clock so it advances while the transport is stopped. Gate on the source
      // state's lock time (dwell) before any auto transition may fire.
      const wall = ctx.nowSec - stateEnteredAtWall;
      if (wall < (fromState?.lockSec ?? 0)) return false;
      return wall >= (g.seconds ?? 0);
    }
    case 'atTime': return g.time != null && crossed(g.time, prev, playhead);
    case 'onMarker': { const m = ctx.markers.find(mk => mk.id === g.markerId); return !!m && crossed(m.time, prev, playhead); }
    // A GAP appeared on the layer: a clip was live under prev and none is under cur.
    //
    // DELIBERATE: this does NOT fire for the layer's last clip when the clip runs to the END of a
    // non-looping timeline. The end-stop parks the playhead on the LAST FRAME (end - 1/fps), which is
    // still INSIDE that clip — by design: parking exactly on `end` leaves no clip under the playhead and
    // the show would end on black (see timeline.ts's park). So no gap ever opens, and firing here would
    // be asserting "the clip ended" while its final frame is still on the projectors and the LED output.
    // "The show finished" is a different event and now has its own trigger: use 'onTimelineEnd', which
    // fires on exactly that frame. (A clip that ends BEFORE the timeline does still fires this normally.)
    // Firing both on one frame would also be a footgun: tick() takes at most ONE transition per frame,
    // so an author with both out of one state would get whichever came first in `transitions`.
    case 'onClipEnd': return !!g.layerId && ctx.clipActive(g.layerId, prev) && !ctx.clipActive(g.layerId, playhead);
    // The single frame the bound timeline reached its end while playing and not looping (a loop wrap is
    // not an end). Set by the engine's end-stop; a one-frame pulse, so this can't re-fire while parked.
    case 'onTimelineEnd': return ctx.atEnd;
    // A plugin owns the condition. `stateEnteredAtWall` is handed over because most live triggers are
    // EDGES measured from the state's entry ("a person arrived SINCE we got here"), and the source has
    // no other way to know when that was. An unregistered source is INERT — a project can name a
    // trigger this build has no plugin for (a disabled plugin, a newer version), and that must never
    // be truthy; the registry lookup in the host returns false for it.
    case 'plugin': return !!g.source && ctx.pluginTrigger(g.source, g.params ?? {}, stateEnteredAtWall);
  }
  // Exhaustiveness: a new SmTriggerKind that forgets its case above becomes a COMPILE error here rather
  // than a trigger that silently never fires. The runtime `return false` still stands — a project file
  // can carry a kind this build doesn't know (hand-edit, newer version), and an unknown trigger must be
  // INERT, never truthy.
  const unhandled: never = g.kind;
  void unhandled;
  return false;
}

// Advance the machine one frame. Re-initializes on the enabled rising edge or when the current
// state is missing (graph edited). Evaluates at most one transition per frame to avoid cascades.
export function tick(sm: StateMachine | undefined, playhead: number, prev: number, ctx: SmContext): void {
  lastNowSec = ctx.nowSec;
  if (!sm || !sm.enabled) { lastEnabled = false; return; }
  // External force-enter (double-click / triggers): apply before re-init so enabling can't clobber it.
  if (forcedId != null) {
    const fid = forcedId; forcedId = null; lastEnabled = true;
    if (sm.states.some(s => s.id === fid)) { enter(sm, fid, playhead, ctx, null); return; }
  }
  const justEnabled = !lastEnabled;
  lastEnabled = true;

  const valid = currentStateId != null && sm.states.some(s => s.id === currentStateId);
  if (justEnabled || !valid) {
    const init = sm.initialStateId && sm.states.some(s => s.id === sm.initialStateId) ? sm.initialStateId : (sm.states[0]?.id ?? null);
    if (init) enter(sm, init, playhead, ctx, null); else { currentStateId = null; notify(); }
    return; // re-evaluate transitions next frame
  }

  const from = sm.states.find(s => s.id === currentStateId);

  // EVALUATE, THEN GATE — the order is load-bearing, and it used to be the other way round.
  //
  // A trigger source can be STATEFUL (a LiDAR zone rule remembers whether it has been armed since the
  // state was entered), and it only sees the frames on which it is ASKED. Skipping the question while a
  // transition's guard is closed therefore blinded it for exactly the window the guard exists to cover:
  // the visitor walked into the zone at t=3 while the film played, `requireEnd` swallowed the question,
  // and when the hold opened the gate at t=12 the source was being asked for the first time — it saw
  // somebody merely STANDING there, not ARRIVING, and the show never advanced. The person had to walk
  // out and back in. That is the exact flow the hold was built for.
  //
  // So the guard suppresses the ACTION, never the evaluation. Core triggers are stateless tests
  // (crossings, a one-frame end pulse) so asking them under a closed guard costs nothing and changes
  // nothing. It is a documented part of the SmTriggerContribution contract — see docs/SDK.md.
  const fires = (tr: SmTransition): boolean => {
    // Both guards apply the same discipline: evaluate FIRST, then decide whether the result may ACT.
    // && short-circuits, so contentGated is only consulted once the trigger has actually fired — a
    // transition nobody is taking never starts a wait whose deadline would tick while the show was
    // somewhere else entirely.
    const fired = triggerFires(tr, from, playhead, prev, ctx);   // ALWAYS ask — keeps sources warm
    return fired && !gated(tr, ctx) && !contentGated(tr, sm.states.find(s => s.id === tr.to)?.sceneId, ctx);
  };

  // 1. THE CURRENT STATE'S OWN EDGES — explicit beats global.
  for (const tr of sm.transitions) {
    if (tr.fromAny || tr.from !== currentStateId) continue;
    if (fires(tr)) { enter(sm, tr.to, playhead, ctx, tr); return; }
  }
  // 2. GLOBAL RULES — evaluated from whatever state we are in.
  //
  // ⚠ SKIP ONE WHOSE TARGET IS THE STATE WE ARE ALREADY IN. Its condition is typically a LEVEL that
  // stays true for as long as somebody stands in a zone, so a self-targeting global would re-enter the
  // same state on every frame — and entry is idempotent-and-restarting, so the scene's timeline would
  // seek back to frame 0 sixty times a second: a frozen picture, a hammered decoder, and a machine
  // reporting itself perfectly healthy.
  for (const tr of sm.transitions) {
    if (!tr.fromAny || tr.to === currentStateId) continue;
    if (fires(tr)) { enter(sm, tr.to, playhead, ctx, tr); return; }
  }

  // 3. IDLE RESET — the unattended safety net (StateMachine.idleResetSec).
  //
  // We only reach here when NO transition fired this frame: the current state has reached its end and
  // is just sitting there. Track the hold's rising edge on the standalone wall clock (so it advances
  // through a held show, whose transport is alive but frozen), and once the state has been held with no
  // way out for idleResetSec, force-return to the initial state — the same "go home" enter() re-init
  // does, so a venue that emptied mid-show restarts its attract loop instead of freezing on a reaction.
  //
  // Deliberately LAST: an explicit or global edge out of the held state always wins, so the reset can
  // never pre-empt an authored exit. Deliberately keyed on `held`, not plain dwell: a looping/no-hold
  // state never "reached its end", and the initial (idle) state is skipped so it can never reset to
  // itself. `heldSinceWall` is cleared by enter(), so entering the reset target re-arms it cleanly.
  heldSinceWall = ctx.held ? (heldSinceWall ?? ctx.nowSec) : null;
  const idle = sm.idleResetSec;
  if (idle && idle > 0 && heldSinceWall != null && ctx.nowSec - heldSinceWall >= idle) {
    const init = sm.initialStateId && sm.states.some(s => s.id === sm.initialStateId) ? sm.initialStateId : (sm.states[0]?.id ?? null);
    if (init && init !== currentStateId) {
      console.info(`[fsm] idle reset: held ${Math.round(ctx.nowSec - heldSinceWall)}s with no transition → returning to initial state`);
      enter(sm, init, playhead, ctx, null);
    }
  }
}

// Fire a manual transition (by id) out of the current state — wired to UI buttons / external triggers.
export function triggerManual(sm: StateMachine | undefined, transitionId: string, playhead: number, ctx: SmContext): void {
  if (!sm || !sm.enabled) return;
  lastNowSec = ctx.nowSec;
  // A GLOBAL rule is firable from anywhere, so it qualifies whatever the current state is — that is the
  // whole point of it, and it must hold on this path too or the lane button, OSC and the tablet would
  // each refuse a rule the machine itself would honour.
  const tr = sm.transitions.find(t => t.id === transitionId && (t.fromAny ? t.to !== currentStateId : t.from === currentStateId));
  // NOTE the absence of gated(): requireEnd guards the AUTOMATIC path only. A human firing this by hand
  // has context the machine does not, and a control that silently no-ops teaches them it is broken. The
  // UI flags an early press instead (StateLane), so the choice is informed, not blocked. See gated().
  if (tr) enter(sm, tr.to, playhead, ctx, tr);
}
