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

// THE RULE VOCABULARY — and the whole point of this type is that there is only ONE of it. The one-zone
// form and every combination term ask the SAME five questions of a zone. `level()` always computed all
// five; the combination path merely hardcoded `enter`, which is why stacking a dwell on one zone with
// an emptiness on another used to need a chain of intermediate states.
export interface ZoneRule {
  edge?: ZoneEdge;   // absent = 'enter' = "is occupied"
  seconds?: number;  // occupiedFor / emptyFor
  n?: number;        // countAtLeast
}

// One term of a combination: a zone, its OWN rule, optionally negated.
//
// ZERO MIGRATION, and not by luck. A term written before per-term rules is `{zone}` or `{zone,not}`,
// and `edge` defaulting to 'enter' makes that EXACTLY what it always meant — zoneLevel(zone, {}) is
// `st.occupied`, the same expression the old code inlined. Every terms[] on disk evaluates, describes
// and fires identically. (`{zone,not:true}` is also precisely `{zone,edge:'exit'}` now — so for those
// two kinds NOT *is* the other rule. It stays essential for the other three: ¬(occupied for 5s) is
// true whenever the zone is empty OR somebody has been there less than 5s, which is NOT "empty for 5s".)
export interface ZoneTerm extends ZoneRule { zone: string; not?: boolean }

export interface ZoneTriggerParams extends ZoneRule {
  // The ONE-ZONE form (still what the simple editor writes). Its rule fields come from ZoneRule.
  zoneId?: string;
  // The COMBINATION form. Present `terms` wins over the one-zone fields above.
  //
  // ⚠ A TERM IS A STATE OF THE ROOM, NOT AN EVENT — and that is not a limitation to route around, it
  // is what makes the combination mean anything. "Someone enters A" and "someone enters B" are only
  // ever both true on the SAME FRAME, which never happens in a real room. So a term contributes a
  // LEVEL — is occupied / empty for 5s / 3+ people — and the arm-and-hold above is applied to the
  // WHOLE SENTENCE, once, rather than to each word. A conjunction is therefore also ORDER-AGNOSTIC:
  // it fires at whichever moment completes the pair. Order belongs in the state graph, as an
  // intermediate state, which enforces it properly.
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

// ⚠ EVERY FIELD `level()` READS MUST APPEAR HERE. The memo is keyed by the RULE, not the transition —
// "two identical rules from the same state are the same question" — and that is sound only while the
// key is INJECTIVE over the rule space. Per-term rules widened that space, so a key covering only zone
// ids and NOTs stopped telling genuinely different rules apart.
//
// The failure is not subtle once seen. Two edges out of one state: `ALL[zA]` and
// `ALL[zA occupiedFor 60s]`. Sharing one key, a visitor walks in and stays: each frame the 60s rule is
// false and sets armed = true, the plain rule reads that same armed and FIRES — 60 times a second, for
// as long as somebody stands there. Nothing throws, and the two params objects visibly differ, so it is
// invisible on inspection. Guarded by verify:invariants.
const termSig = (t: ZoneTerm): string =>
  `${t.not ? '!' : ''}${t.zone}@${t.edge ?? 'enter'}:${t.seconds ?? 0}:${t.n ?? 0}`;

const sig = (p: ZoneTriggerParams): string =>
  p.terms?.length
    ? `c:${p.match ?? 'all'}:${p.terms.map(termSig).join(',')}`
    : `z:${p.zoneId ?? ''}:${p.edge ?? 'enter'}:${p.seconds ?? 0}:${p.n ?? 0}`;

// ONE ZONE'S RULE, AS A LEVEL — the whole vocabulary, in one place, with two equal callers: the
// one-zone form and every combination term. `undefined` = unanswerable (the zone is gone, or this look
// does not listen to it), which is NOT the same as false: answering "false" would make an `exit` or
// `empty for` rule fire in a scene that was never watching that part of the room.
export function zoneLevel(zoneId: string, r: ZoneRule, nowSec: number): boolean | undefined {
  if (!zoneId) return undefined;
  const st = zones.getState(zoneId);
  if (!st) return undefined;
  switch (r.edge ?? 'enter') {
    case 'enter': return st.occupied;
    case 'exit': return !st.occupied;
    // The dwell, as a level: true WHILE the zone has been occupied/empty for at least `seconds`. The old
    // "the run must have started inside this state" guard is gone because `armed` already provides it —
    // a dwell that was already satisfied when the state began arrives with armed=false.
    case 'occupiedFor':
      return st.occupied && !!st.occupiedSinceMs && nowSec - st.occupiedSinceMs / 1000 >= (r.seconds ?? 0);
    case 'emptyFor':
      return !st.occupied && !!st.emptySinceMs && nowSec - st.emptySinceMs / 1000 >= (r.seconds ?? 0);
    // A crowd threshold. This used to be a bare level that re-fired every frame while the crowd stood
    // there; arm-and-hold makes it one shot per crowd, like every other rule.
    case 'countAtLeast': return st.count >= Math.max(1, r.n ?? 1);
  }
  return undefined;
}

// One term's contribution, with its NOT applied. Exported so the editor's live dot shows what the
// RUNTIME computes rather than a re-implementation that can drift from it.
export function termLevel(t: ZoneTerm, nowSec: number): boolean | undefined {
  const v = zoneLevel(t.zone, t, nowSec);
  return v === undefined ? undefined : (t.not ? !v : v);
}

// The whole rule's current value as a LEVEL — one zone, or a flat boolean expression over terms.
function level(p: ZoneTriggerParams, nowSec: number): boolean | undefined {
  if (p.terms?.length) {
    const vals = p.terms.map((t) => termLevel(t, nowSec));
    // ONE UNANSWERABLE TERM POISONS THE WHOLE EXPRESSION. An `all` over a missing zone is not "false"
    // and an `any` is not "whatever the others say" — the author asked about a zone this look cannot
    // see, so the honest answer is "I don't know", and an unknown rule never fires. It now poisons on a
    // term's own rule as well as on its zone.
    if (vals.some((v) => v === undefined)) return undefined;
    return (p.match ?? 'all') === 'any' ? vals.some(Boolean) : vals.every(Boolean);
  }
  return zoneLevel(p.zoneId ?? '', p, nowSec);
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

// A term's rule as a SUFFIX on its zone name, for the graph edge label — added only when the rule is
// not the plain "is occupied" default, so every project written before per-term rules produces a
// byte-identical label and no edge-label screenshot or doc example goes stale.
//
// `⌀` = nobody, `5s` = occupied that long, `⌀30s` = empty that long, `3+` = headcount. `⏱` is
// deliberately NOT used: StateGraphEditor already prefixes it for requireEnd, and two meanings for one
// glyph on one label is unreadable.
const termSuffix = (r: ZoneRule): string => {
  switch (r.edge ?? 'enter') {
    case 'enter': return '';
    case 'exit': return ' ⌀';
    case 'occupiedFor': return ` ${r.seconds ?? 0}s`;
    case 'emptyFor': return ` ⌀${r.seconds ?? 0}s`;
    case 'countAtLeast': return ` ${r.n ?? 1}+`;
  }
  return '';
};

export function describeZoneTrigger(p: ZoneTriggerParams): string {
  if (p.terms?.length) {
    const join = (p.match ?? 'all') === 'any' ? ' ∨ ' : ' ∧ ';
    return p.terms.map((t) => `${t.not ? '¬' : ''}${zoneName(t.zone)}${termSuffix(t)}`).join(join);
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
