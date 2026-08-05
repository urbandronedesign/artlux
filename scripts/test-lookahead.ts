// Standalone test for services/smLookahead — the preloader's targeting.
//
// Runnable with no Electron, no bundler and no app (see scripts/tsconfig.test.json). The module is a
// pure function of the machine, and its wrong answer is expensive in a way that is invisible: warming
// the wrong two scenes costs nothing observable until a venue takes a cut that was supposed to be
// hitless and isn't. So the ordering is asserted here rather than reasoned about.
//
//   npx tsc -p scripts/tsconfig.test.json && node .tmp-tests/scripts/test-lookahead.js

import { reachableNext } from '../src/renderer/services/smLookahead';
import type { StateMachine, SmTransition, SmState } from '../src/renderer/types';

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log(`  ok   ${name}`); return; }
  console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`);
  failed++;
}

const st = (id: string, sceneId?: string): SmState =>
  ({ id, name: id, x: 0, y: 0, entry: [], ...(sceneId ? { sceneId } : {}) });
const tr = (id: string, from: string, to: string, trigger: SmTransition['trigger'], extra: Partial<SmTransition> = {}): SmTransition =>
  ({ id, from, to, trigger, ...extra });

const sm = (states: SmState[], transitions: SmTransition[]): StateMachine =>
  ({ enabled: true, states, transitions, initialStateId: states[0]?.id ?? null, regions: [] });

const scenes = (r: ReturnType<typeof reachableNext>) => r.map(e => e.sceneId);

// ── A shorter afterDelay is more imminent than a longer one ──────────────────────────────────────
check('afterDelay sorts by delay',
  scenes(reachableNext(sm(
    [st('a', 'sa'), st('b', 'sb'), st('c', 'sc'), st('d', 'sd')],
    [tr('t1', 'a', 'b', { kind: 'afterDelay', seconds: 30 }),
     tr('t2', 'a', 'c', { kind: 'afterDelay', seconds: 2 }),
     tr('t3', 'a', 'd', { kind: 'afterDelay', seconds: 10 })],
  ), 'a')),
  ['sc', 'sd', 'sb']);

// ── Tier order: any timed edge beats end-of-timeline beats plugin beats manual ───────────────────
check('trigger kinds rank by imminence',
  scenes(reachableNext(sm(
    [st('a', 'sa'), st('b', 'sb'), st('c', 'sc'), st('d', 'sd'), st('e', 'se')],
    [tr('t1', 'a', 'b', { kind: 'manual' }),
     tr('t2', 'a', 'c', { kind: 'plugin', source: 'lidar.zone' }),
     tr('t3', 'a', 'd', { kind: 'onTimelineEnd' }),
     tr('t4', 'a', 'e', { kind: 'afterDelay', seconds: 999 })],
  ), 'a')),
  ['se', 'sd', 'sc', 'sb']);

// ── fromAny is INCLUDED (the old filter could never match it) but demoted ────────────────────────
const withGlobal = sm(
  [st('a', 'sa'), st('b', 'sb'), st('home', 'shome')],
  [tr('t1', 'a', 'b', { kind: 'manual' }),
   tr('t_home', '', 'home', { kind: 'afterDelay', seconds: 1 }, { fromAny: true })],
);
check('fromAny is reachable from any state', scenes(reachableNext(withGlobal, 'a')).includes('shome'), true);
check('fromAny is demoted below a local edge', scenes(reachableNext(withGlobal, 'a')), ['sb', 'shome']);
check('fromAny is reachable from an unrelated state too', scenes(reachableNext(withGlobal, 'b')), ['shome']);

// ── Dedupe by scene: two edges into the same look are one warm, keeping the best score ───────────
check('deduped by scene, best score wins',
  reachableNext(sm(
    [st('a', 'sa'), st('b', 'sb'), st('c', 'sb')],   // b and c share scene 'sb'
    [tr('t1', 'a', 'b', { kind: 'manual' }),
     tr('t2', 'a', 'c', { kind: 'afterDelay', seconds: 3 })],
  ), 'a').length,
  1);

// ── A self-edge re-enters the ACTIVE pool — never a standby candidate ────────────────────────────
check('self-edge is dropped',
  scenes(reachableNext(sm(
    [st('a', 'sa'), st('b', 'sb')],
    [tr('t1', 'a', 'a', { kind: 'afterDelay', seconds: 1 }),
     tr('t2', 'a', 'b', { kind: 'manual' })],
  ), 'a')),
  ['sb']);

// ── A state with no bound look has no pool to warm ───────────────────────────────────────────────
check('states without a scene are skipped',
  scenes(reachableNext(sm(
    [st('a', 'sa'), st('b')],
    [tr('t1', 'a', 'b', { kind: 'afterDelay', seconds: 1 })],
  ), 'a')),
  []);

// ── requireEnd cannot fire before the source timeline finishes → less imminent ───────────────────
check('requireEnd is demoted below the same trigger without it',
  scenes(reachableNext(sm(
    [st('a', 'sa'), st('b', 'sb'), st('c', 'sc')],
    [tr('t1', 'a', 'b', { kind: 'onTimelineEnd' }, { requireEnd: true }),
     tr('t2', 'a', 'c', { kind: 'onTimelineEnd' })],
  ), 'a')),
  ['sc', 'sb']);

// ── Junk must not sort as "fires immediately" ────────────────────────────────────────────────────
check('a junk afterDelay does not outrank a real one',
  scenes(reachableNext(sm(
    [st('a', 'sa'), st('b', 'sb'), st('c', 'sc')],
    [tr('t1', 'a', 'b', { kind: 'afterDelay' }),                       // no seconds
     tr('t2', 'a', 'c', { kind: 'afterDelay', seconds: 5 })],
  ), 'a')),
  ['sc', 'sb']);

// ── Degenerate machines must not throw (a project file is not a promise) ─────────────────────────
check('null machine', reachableNext(null, 'a'), []);
check('malformed machine', reachableNext({ enabled: true } as unknown as StateMachine, 'a'), []);

// ── THE HUB CASE — what the budget fix exists for ────────────────────────────────────────────────
const hub = sm(
  [st('hub', 'shub'), ...Array.from({ length: 10 }, (_, i) => st(`s${i}`, `sc${i}`))],
  Array.from({ length: 10 }, (_, i) => tr(`t${i}`, 'hub', `s${i}`, { kind: 'afterDelay', seconds: 4 + i })),
);
check('hub returns all candidates, soonest first', scenes(reachableNext(hub, 'hub')).slice(0, 3), ['sc0', 'sc1', 'sc2']);
check('caller trims to budget (MAX_WARM=2)', reachableNext(hub, 'hub').slice(0, 2).length, 2);

console.log(failed ? `\n${failed} FAILED\n` : '\nall passed\n');
process.exit(failed ? 1 : 0);
