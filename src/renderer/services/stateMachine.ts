import { StateMachine, SmTransition, SmAction, Marker } from '../types';

// Finite-state-machine runtime for the timeline control layer. Pure-ish module singleton driven
// once per frame by the engine (services/timeline.ts), main window only. It never touches the
// transport directly — it emits TransportIntents which App turns into React state so App stays the
// single writer of `playing` (see App's subscribeIntent). Current-state is exposed render-free via
// subscribeState for the timeline's state lane.

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
  recallScene: (sceneId: string) => void; // recall a Scene by id (routed via cueBus to App)
  fireCue: (cueId: string) => void;       // fire a granular Cue by id (routed via cueBus to App)
}

let currentStateId: string | null = null;
let stateEnteredAt = 0;     // playhead seconds when the current state was entered
let lastEnabled = false;    // for rising-edge (re)initialization
const stateSubs = new Set<(id: string | null) => void>();

const notify = (): void => { stateSubs.forEach(cb => cb(currentStateId)); };

// Subscribe to current-state changes (fires immediately with the current value).
export function subscribeState(cb: (id: string | null) => void): () => void {
  stateSubs.add(cb); cb(currentStateId); return () => { stateSubs.delete(cb); };
}
export function getCurrentStateId(): string | null { return currentStateId; }

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

function enter(sm: StateMachine, stateId: string, playhead: number, ctx: SmContext): void {
  currentStateId = stateId;
  stateEnteredAt = playhead;
  const s = sm.states.find(st => st.id === stateId);
  if (s) runEntry(s.entry, ctx);
  notify();
}

// Crossing test for an absolute time T over the prev→cur playhead window (handles loop/backward
// wrap when cur < prev: the window covers prev→end and start→cur).
function crossed(T: number, prev: number, cur: number): boolean {
  if (cur >= prev) return T > prev && T <= cur;
  return T > prev || T <= cur;
}

function triggerFires(tr: SmTransition, playhead: number, prev: number, ctx: SmContext): boolean {
  const g = tr.trigger;
  switch (g.kind) {
    case 'manual': return false; // only via triggerManual()
    case 'afterDelay': { const dt = playhead - stateEnteredAt; return dt < 0 || dt >= (g.seconds ?? 0); }
    case 'atTime': return g.time != null && crossed(g.time, prev, playhead);
    case 'onMarker': { const m = ctx.markers.find(mk => mk.id === g.markerId); return !!m && crossed(m.time, prev, playhead); }
    case 'onClipEnd': return !!g.layerId && ctx.clipActive(g.layerId, prev) && !ctx.clipActive(g.layerId, playhead);
  }
  return false;
}

// Advance the machine one frame. Re-initializes on the enabled rising edge or when the current
// state is missing (graph edited). Evaluates at most one transition per frame to avoid cascades.
export function tick(sm: StateMachine | undefined, playhead: number, prev: number, ctx: SmContext): void {
  if (!sm || !sm.enabled) { lastEnabled = false; return; }
  const justEnabled = !lastEnabled;
  lastEnabled = true;

  const valid = currentStateId != null && sm.states.some(s => s.id === currentStateId);
  if (justEnabled || !valid) {
    const init = sm.initialStateId && sm.states.some(s => s.id === sm.initialStateId) ? sm.initialStateId : (sm.states[0]?.id ?? null);
    if (init) enter(sm, init, playhead, ctx); else { currentStateId = null; notify(); }
    return; // re-evaluate transitions next frame
  }

  for (const tr of sm.transitions) {
    if (tr.from !== currentStateId) continue;
    if (triggerFires(tr, playhead, prev, ctx)) { enter(sm, tr.to, playhead, ctx); return; }
  }
}

// Fire a manual transition (by id) out of the current state — wired to UI buttons / external triggers.
export function triggerManual(sm: StateMachine | undefined, transitionId: string, playhead: number, ctx: SmContext): void {
  if (!sm || !sm.enabled) return;
  const tr = sm.transitions.find(t => t.id === transitionId && t.from === currentStateId);
  if (tr) enter(sm, tr.to, playhead, ctx);
}
