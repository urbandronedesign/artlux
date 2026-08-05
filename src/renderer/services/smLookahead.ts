// WHICH STATE IS THE SHOW ABOUT TO ENTER? — the preloader's targeting.
//
// Warming is a budget (timelinePreloader.MAX_WARM), so the question is not "what is reachable" but
// "what is reachable SOONEST". App used to answer the first question: it took every transition whose
// `from` is the current state and warmed them all. Two things were wrong with that.
//
//   1. A HUB STATE BLEW THE BUDGET. Ten outgoing transitions meant ten warm pools — ten sets of
//      per-layer <video> decoders — against a budget of two. (evictExcess then failed to enforce it,
//      for its own separate reason; both halves had to be fixed or the fix would just thrash.)
//   2. GLOBAL RULES WERE INVISIBLE. `fromAny` transitions (SmTransition.fromAny — "someone walks into
//      the entrance → start the welcome, whatever the show is doing") never matched `t.from ===
//      stateId`, so the one edge most likely to fire in an interactive installation was the one edge
//      never preloaded. The venue's most important cut was always the cold one.
//
// So: rank by HOW SOON AN EDGE CAN FIRE, and let the caller take the top MAX_WARM. Ranking is a pure
// function of the machine — no engine, no DOM, no time — so it is testable with a throwaway tsc script
// (see docs/DEVELOPMENT.md → Testing) and cheap enough to run on every state change.

import type { StateMachine, SmTransition } from '../types';

// Lower score = warm it sooner. The ordering encodes what an edge's trigger says about its imminence,
// not how important it is:
//   · afterDelay      — the show TELLS us when. Ranked by the delay itself, so a 2 s edge outranks a
//                       30 s one. Capped below the next tier so any timed edge beats an untimed one.
//   · onTimelineEnd   — arrives on its own, at a known-ish moment (the state's own out-point).
//   · onClipEnd       — same, but mid-timeline and layer-dependent.
//   · atTime/onMarker — playhead-crossing: needs the transport to run, but needs no world event.
//   · plugin          — a person, a pose, a DMX level. May be instant, may be never.
//   · manual          — an operator's hand. Unknowable.
// `fromAny` is demoted one tier: it is reachable from EVERYWHERE, so it is always a candidate and
// therefore never evidence of imminence. Warming it permanently would spend the whole budget on the
// edge least likely to be the next one taken from THIS state.
const TIER = {
  timed: 0,        // afterDelay — plus the delay in seconds, so 0..~1000 stays inside this tier
  timelineEnd: 2000,
  clipEnd: 3000,
  playhead: 4000,  // atTime / onMarker
  plugin: 5000,
  manual: 6000,
} as const;

const FROM_ANY_PENALTY = 10_000;

function scoreOf(t: SmTransition): number {
  let base: number;
  switch (t.trigger?.kind) {
    case 'afterDelay': {
      const s = t.trigger.seconds;
      // A junk/absent delay must not sort as "fires immediately" — treat it as the end of its tier.
      base = TIER.timed + (typeof s === 'number' && Number.isFinite(s) && s >= 0 ? Math.min(s, 1000) : 1000);
      break;
    }
    case 'onTimelineEnd': base = TIER.timelineEnd; break;
    case 'onClipEnd': base = TIER.clipEnd; break;
    case 'atTime': case 'onMarker': base = TIER.playhead; break;
    case 'plugin': base = TIER.plugin; break;
    case 'manual': default: base = TIER.manual; break;
  }
  // requireEnd gates the trigger on the source timeline having finished — it cannot fire before then,
  // so it is strictly less imminent than the same trigger without the guard. One tier, not a penalty
  // big enough to reorder across the fromAny boundary.
  if (t.requireEnd) base += 500;
  return t.fromAny ? base + FROM_ANY_PENALTY : base;
}

export interface LookaheadEntry {
  stateId: string;
  sceneId: string;
  score: number;
}

/**
 * The states the machine can reach from `stateId`, soonest-first, deduped by SCENE (two edges into
 * the same look are one warm), self-edges dropped (the active pool is never standby).
 *
 * Returns every candidate — trimming to the budget is the caller's job, so a caller that wants a
 * deeper window for its own reasons (a hover preview, a cue-grid column) can take more.
 */
export function reachableNext(sm: StateMachine | null | undefined, stateId: string): LookaheadEntry[] {
  if (!sm || !Array.isArray(sm.transitions) || !Array.isArray(sm.states)) return [];
  const sceneOf = new Map(sm.states.map(s => [s.id, s.sceneId]));
  const best = new Map<string, LookaheadEntry>(); // by sceneId — the pool key is the scene
  for (const t of sm.transitions) {
    if (!t || (!t.fromAny && t.from !== stateId)) continue;
    if (t.to === stateId) continue; // a self-edge re-enters the ACTIVE pool; nothing to stand by
    const sceneId = sceneOf.get(t.to);
    if (!sceneId) continue;          // a state with no bound look has no pool to warm
    const score = scoreOf(t);
    const prev = best.get(sceneId);
    if (!prev || score < prev.score) best.set(sceneId, { stateId: t.to, sceneId, score });
  }
  return [...best.values()].sort((a, b) => a.score - b.score);
}
