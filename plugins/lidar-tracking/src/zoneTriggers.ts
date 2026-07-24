import type { SmTriggerEvalContext } from '@artlux/sdk/renderer';
import * as zones from './zones';

// The RULES a trigger zone can fire on — the plugin half of the host's `{ kind:'plugin', source,
// params }` trigger. Core persists the params and never reads them; everything here is what they mean.
//
// ── EVERY RULE IS A LEVEL, AND FIRING IS "ARM AND HOLD" ──────────────────────────────────────────
// There is exactly ONE mechanism, and the five rule kinds are just five ways of computing its input:
//
//     on a new state entry:  armed = !value      // already true when we arrived ⇒ it must go false first
//     each frame:            if (!value) armed = true
//     fire  ⇔  armed && value
//
// TWO PROBLEMS FALL OUT OF THAT SHAPE, AND BOTH WERE REAL:
//
// 1. A SHOW THAT REACTS TO PEOPLE RE-ENTERS ITS STATES CONSTANTLY, and the visitor who caused the last
//    hop is usually STILL STANDING THERE. A plain level test ("is the zone occupied?") therefore fires
//    again on the first frame of the new state, and again, and again — the graph runs away and the venue
//    sees a strobe of looks. `armed` starts false whenever the condition is already true on entry, so it
//    cannot fire until the world actually changes.
//
// 2. …BUT A ONE-FRAME RISING EDGE IS TOO NARROW, because a transition can be GUARDED (requireEnd: "only
//    once this state's picture has finished"). The canonical interactive state is: play a film, hold the
//    last frame, advance when someone is there. The visitor arrives at t=3, DURING the film; the guard
//    opens at t=12. A rising edge fired — and was discarded — at t=3, so at t=12 nothing happens and the
//    person has to walk out and back in to start the show. Holding `armed && value` true for as long as
//    the condition lasts makes t=12 fire, which is what the whole hold feature was built for.
//    (This is also why services/stateMachine.ts EVALUATES a transition's trigger before applying its
//    guard: the guard suppresses the ACTION, not the evaluation, so this memo keeps a complete history.)
//
// A COMBO is the same mechanism over a boolean expression instead of a single zone — see below.

export const ZONE_TRIGGER_SOURCE = 'lidar.zone';

export type ZoneEdge = 'enter' | 'exit' | 'occupiedFor' | 'emptyFor' | 'countAtLeast';

// One term of a combination: a zone's occupancy, optionally negated.
export interface ZoneTerm { zone: string; not?: boolean }

export interface ZoneTriggerParams {
  // The ONE-ZONE form (unchanged, still what the simple editor writes).
  zoneId?: string;
  edge?: ZoneEdge;
  seconds?: number;  // occupiedFor / emptyFor
  n?: number;        // countAtLeast
  // The COMBINATION form. Present `terms` wins over the one-zone fields above.
  //
  // ⚠ EDGES DO NOT "AND". "Someone enters A" and "someone enters B" are only ever both true on the SAME
  // FRAME, which essentially never happens — so a combo is deliberately NOT a conjunction of events. It
  // is a boolean expression over OCCUPANCY (a level), fed to the same arm-and-hold rule above. That is
  // what an author means by "A and B": both zones have somebody in them.
  //
  // ONE LEVEL DEEP, deliberately: ALL/ANY plus a per-term NOT covers the installation logic people
  // actually write, and a nested expression tree is a UI nobody can use under show pressure.
  match?: 'all' | 'any';
  terms?: ZoneTerm[];
}

// Per-rule memory. Keyed by a stable signature of the params rather than by transition id, because
// `fires` is not told which transition is asking — and does not need to be: two identical rules
// evaluated from the same state are the same question, and sharing one memo is correct.
interface Memo { enteredAtSec: number; armed: boolean }
const memos = new Map<string, Memo>();

const sig = (p: ZoneTriggerParams): string =>
  p.terms?.length
    ? `c:${p.match ?? 'all'}:${p.terms.map((t) => `${t.not ? '!' : ''}${t.zone}`).join(',')}`
    : `z:${p.zoneId ?? ''}:${p.edge ?? 'enter'}:${p.seconds ?? 0}:${p.n ?? 0}`;

// Is a single zone occupied RIGHT NOW? An inactive zone (not listened to by the current look) or a
// deleted one has no state at all, and answers NEITHER true nor false — see `level` below.
const occupied = (zoneId: string): boolean | undefined => zones.getState(zoneId)?.occupied;

// The rule's current value as a LEVEL. `undefined` = unanswerable (the zone is gone, or this look does
// not listen to it), which is NOT the same as false: answering "false" would make an `exit` or
// `empty for` rule fire in a scene that was never watching that part of the room.
function level(p: ZoneTriggerParams, nowSec: number): boolean | undefined {
  if (p.terms?.length) {
    const vals = p.terms.map((t) => {
      const o = occupied(t.zone);
      return o === undefined ? undefined : (t.not ? !o : o);
    });
    // ONE UNANSWERABLE TERM POISONS THE WHOLE EXPRESSION. An `all` over a missing zone is not "false"
    // and an `any` is not "whatever the others say" — the author asked about a zone this look cannot
    // see, so the honest answer is "I don't know", and an unknown rule never fires.
    if (vals.some((v) => v === undefined)) return undefined;
    return (p.match ?? 'all') === 'any' ? vals.some(Boolean) : vals.every(Boolean);
  }

  if (!p.zoneId) return undefined;
  const st = zones.getState(p.zoneId);
  if (!st) return undefined;
  switch (p.edge ?? 'enter') {
    case 'enter': return st.occupied;
    case 'exit': return !st.occupied;
    // The dwell, as a level: true WHILE the zone has been occupied/empty for at least `seconds`. The old
    // "the run must have started inside this state" guard is gone because `armed` already provides it —
    // a dwell that was already satisfied when the state began arrives with armed=false.
    case 'occupiedFor':
      return st.occupied && !!st.occupiedSinceMs && nowSec - st.occupiedSinceMs / 1000 >= (p.seconds ?? 0);
    case 'emptyFor':
      return !st.occupied && !!st.emptySinceMs && nowSec - st.emptySinceMs / 1000 >= (p.seconds ?? 0);
    // A crowd threshold. This used to be a bare level that re-fired every frame while the crowd stood
    // there; arm-and-hold makes it one shot per crowd, like every other rule.
    case 'countAtLeast': return st.count >= Math.max(1, p.n ?? 1);
  }
  return undefined;
}

export function zoneTriggerFires(p: ZoneTriggerParams, ctx: SmTriggerEvalContext): boolean {
  const value = level(p, ctx.nowSec);
  if (value === undefined) return false;   // unanswerable ⇒ inert, never truthy

  const key = sig(p);
  let m = memos.get(key);
  if (!m || m.enteredAtSec !== ctx.stateEnteredAtSec) {
    // A NEW STATE ENTRY. Arm only if the condition is currently FALSE — otherwise the world has not
    // changed since we got here and the rule must wait for it to.
    m = { enteredAtSec: ctx.stateEnteredAtSec, armed: !value };
    memos.set(key, m);
  }
  if (!value) { m.armed = true; return false; }
  return m.armed;
}

const zoneName = (id: string): string => zones.getZones().find((z) => z.id === id)?.name || 'zone?';

export function describeZoneTrigger(p: ZoneTriggerParams): string {
  if (p.terms?.length) {
    const join = (p.match ?? 'all') === 'any' ? ' ∨ ' : ' ∧ ';
    return p.terms.map((t) => `${t.not ? '¬' : ''}${zoneName(t.zone)}`).join(join);
  }
  const name = zoneName(p.zoneId ?? '');
  switch (p.edge ?? 'enter') {
    case 'enter': return `${name}: someone enters`;
    case 'exit': return `${name}: everyone leaves`;
    case 'occupiedFor': return `${name}: occupied ${p.seconds ?? 0}s`;
    case 'emptyFor': return `${name}: empty ${p.seconds ?? 0}s`;
    case 'countAtLeast': return `${name}: ${p.n ?? 1}+ people`;
  }
  return name;
}

// Every zone id a rule depends on — for the editor's "this zone is not active in that scene" warning.
export function zonesUsedBy(p: ZoneTriggerParams): string[] {
  if (p.terms?.length) return p.terms.map((t) => t.zone).filter(Boolean);
  return p.zoneId ? [p.zoneId] : [];
}

// Drop every memo (a take starting/ending replaces the whole store — see zones.reset()).
export function resetZoneTriggers(): void { memos.clear(); }
