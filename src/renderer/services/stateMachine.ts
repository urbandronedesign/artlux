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
    const fired = triggerFires(tr, from, playhead, prev, ctx);   // ALWAYS ask — keeps stateful sources warm
    return fired && !gated(tr, ctx);
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
