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
// one-frame edge (ctx.atEnd) instead of a time we could test.

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
  for (const tr of sm.transitions) {
    if (tr.from !== currentStateId) continue;
    if (triggerFires(tr, from, playhead, prev, ctx)) { enter(sm, tr.to, playhead, ctx, tr); return; }
  }
}

// Fire a manual transition (by id) out of the current state — wired to UI buttons / external triggers.
export function triggerManual(sm: StateMachine | undefined, transitionId: string, playhead: number, ctx: SmContext): void {
  if (!sm || !sm.enabled) return;
  lastNowSec = ctx.nowSec;
  const tr = sm.transitions.find(t => t.id === transitionId && t.from === currentStateId);
  if (tr) enter(sm, tr.to, playhead, ctx, tr);
}
