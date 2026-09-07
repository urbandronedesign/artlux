// Drive the REAL zone + trigger modules with a REAL venue recording.
// Run: npm run test:zone:take -- <project.artlux> <take.lblob>
//
// The end-to-end CDP harness (test-zone-fsm.cjs) launches an app, takes five minutes and hijacks the
// machine. Everything below the FSM is pure, though — trackingStore takes a snapshot, people.ts merges
// it, zones.ts latches it, zoneTriggers.ts fires on it — so a recorded take can be stepped through all
// of it in about a second, with no Electron, no sensor and no venue. This is where a zone rule should
// be proved; the CDP harness is for the wiring above it.
//
// Real data matters here beyond convenience. A synthetic emitter produces the blobs you thought of; a
// venue recording produces ~0.13 s id flicker, blobs that vanish for a frame and people who stand on a
// zone edge. Half the rules in this file exist because of that behaviour.
import * as fs from 'node:fs';
import * as trackingStore from '../plugins/lidar-tracking/src/trackingStore';
import * as people from '../plugins/lidar-tracking/src/people';
import * as zones from '../plugins/lidar-tracking/src/zones';
import { zoneTriggerFires, resetZoneTriggers, type ZoneTriggerParams } from '../plugins/lidar-tracking/src/zoneTriggers';
import type { TrackingZone } from '../shared/protocol';

// trackingStore coalesces its SUBSCRIBER notifications through requestAnimationFrame — a UI concern
// (it exists so a person walking the room does not re-render React at blob rate). Nothing under test
// subscribes: zones and people both READ the store, in the order this file steps them. So a no-op is
// not a shortcut around the store's behaviour, it removes the half of it that has no meaning here —
// and it keeps the run deterministic rather than at the mercy of a timer.
(globalThis as any).requestAnimationFrame ??= (): number => 0;
(globalThis as any).cancelAnimationFrame ??= (): void => {};

interface Take { name: string; duration: number; fps?: number; frames: { t: number; snap: any }[] }

const [projFile, takeFile] = process.argv.slice(2);
if (!projFile || !takeFile) { console.error('usage: npm run test:zone:take -- <project.artlux> <take.lblob>'); process.exit(1); }
const proj = JSON.parse(fs.readFileSync(projFile, 'utf8'));
const take = JSON.parse(fs.readFileSync(takeFile, 'utf8')) as Take;
const allZones: TrackingZone[] = proj?.scene3D?.trackingZones ?? [];
if (!allZones.length) { console.error('no trackingZones in that project'); process.exit(1); }

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  — ${detail}`}`);
};

// ── The clock ────────────────────────────────────────────────────────────────────────────────────
// zones.ts measures dwell in wall time and people.ts stamps the tracker with it, so the take has to be
// stepped on a clock, not a frame index. Everything reads this one.
let nowMs = 0;
const step = (frame: { snap: any }, dtMs: number): void => {
  nowMs += dtMs;
  trackingStore.applySnapshot(frame.snap);
  people.refresh(nowMs);
  zones.evaluate(nowMs);
};

// Replay the whole take once, calling `each` after every frame. Returns the frame interval used.
function replay(each?: (i: number) => void): number {
  const dt = take.frames.length > 1 ? ((take.frames[1].t - take.frames[0].t) * 1000) || 20 : 20;
  for (let i = 0; i < take.frames.length; i++) { step(take.frames[i], dt); each?.(i); }
  return dt;
}

const reset = (merge: boolean): void => {
  trackingStore.applySnapshot({ surfaces: [] });
  people.reset(); zones.reset(); resetZoneTriggers();
  people.configure(merge, proj?.scene3D?.trackingMergeRadius ?? 0.8, proj?.scene3D?.trackingSurfaceMerge);
  zones.configure(allZones, undefined, proj?.scene3D?.trackingZoneEnterSec, proj?.scene3D?.trackingZoneExitSec);
  nowMs = 0;
};

console.log(`\n${take.name} — ${take.duration.toFixed(1)}s, ${take.frames.length} frames, ${allZones.length} zones\n`);

// ── 1. THE REPORTED BUG: the count is in people only when merging is on ─────────────────────────
// This is the whole report, reproduced from the venue's own recording rather than an emitter.
const peakOf = (merge: boolean): Map<string, number> => {
  reset(merge);
  const peak = new Map<string, number>(allZones.map((z) => [z.id, 0]));
  replay(() => { for (const z of allZones) { const st = zones.getState(z.id); if (st && st.count > peak.get(z.id)!) peak.set(z.id, st.count); } });
  return peak;
};
const raw = peakOf(false), merged = peakOf(true);
const doubled = allZones.filter((z) => raw.get(z.id)! >= 2 && raw.get(z.id)! >= 2 * merged.get(z.id)!);
console.log('  peak occupancy per zone   raw -> merged');
for (const z of allZones) console.log(`    ${z.name.padEnd(10)} ${String(raw.get(z.id)).padStart(3)} -> ${merged.get(z.id)}`);
check('merging changes what a zone counts on real data', [...raw.values()].some((v, i) => v > [...merged.values()][i]));
check('at least one zone counts exactly DOUBLE without merging (the report)', doubled.length > 0,
  `zones halved by merging: ${doubled.map((z) => z.name).join(', ') || 'none'}`);

// ── 2. A PER-TERM RULE, on real blobs ───────────────────────────────────────────────────────────
// Pick the two busiest zones from the recording so the rule can actually be satisfied by it.
const busiest = [...allZones].sort((a, b) => merged.get(b.id)! - merged.get(a.id)!);
const [zBusy, zQuiet] = [busiest[0], busiest[busiest.length - 1]];
const ctx = (enteredAtSec: number) => ({ nowSec: nowMs / 1000, stateEnteredAtSec: enteredAtSec, held: false });

// "the busy zone has held somebody for 1.5s AND the quiet one is empty" — a sentence that was not
// expressible before per-term rules.
const mixed: ZoneTriggerParams = { match: 'all', terms: [
  { zone: zBusy.id, edge: 'occupiedFor', seconds: 1.5 },
  { zone: zQuiet.id, edge: 'exit' },
] };
// …and the same thing with no dwell, which must become true EARLIER on the same recording.
const plain: ZoneTriggerParams = { match: 'all', terms: [{ zone: zBusy.id }, { zone: zQuiet.id, edge: 'exit' }] };

reset(true);
let firstMixed = -1, firstPlain = -1;
replay(() => {
  if (firstPlain < 0 && zoneTriggerFires(plain, ctx(0))) firstPlain = nowMs;
  if (firstMixed < 0 && zoneTriggerFires(mixed, ctx(0))) firstMixed = nowMs;
});
console.log(`\n  rule over "${zBusy.name}" + "${zQuiet.name}":  no dwell fired at ${firstPlain}ms, 1.5s dwell at ${firstMixed}ms`);
check('a per-term dwell fires later than the same rule without one', firstPlain >= 0 && firstMixed > firstPlain,
  `plain=${firstPlain}ms mixed=${firstMixed}ms`);
check('…and by at least the dwell it asked for', firstMixed - firstPlain >= 1400,
  `gap ${firstMixed - firstPlain}ms, expected >= 1400`);

// ── 3. THE MEMO COLLISION — the case the CDP harness never got to ───────────────────────────────
// sig() keys the arm-and-hold memo by the RULE, not the transition, so two rules differing ONLY in a
// per-term field must not share one.
//
// ⚠ "FIRES MORE THAN ONCE" IS NOT THE SYMPTOM, and assuming it was is how this test was wrong on its
// first run. A rule that is true HOLDS true — deliberately, so a transition whose guard opens later
// still fires (see the arm-and-hold note in zoneTriggers.ts). Counting fires cannot tell a collision
// from correct behaviour, because both return true on every frame the zone is occupied.
//
// The discriminator is STATE RE-ENTRY. On a new stateEnteredAtSec the memo re-seeds `armed = !value`:
// somebody still standing in the zone means value is already true, so the rule must NOT fire — that is
// the anti-strobe rule the whole mechanism exists for. Under a shared key the never-true 600s rule
// sets `armed = true` again on the very next frame, and the plain rule fires anyway. So: re-enter the
// state while the zone is occupied, and watch.
reset(true);
const never: ZoneTriggerParams = { match: 'all', terms: [{ zone: zBusy.id, edge: 'occupiedFor', seconds: 600 }] };
const plainRule: ZoneTriggerParams = { match: 'all', terms: [{ zone: zBusy.id }] };
let neverFires = 0, firedAfterReentry = 0, framesTested = 0, reenteredAt = -1;
replay(() => {
  const occupied = !!zones.getState(zBusy.id)?.occupied;
  if (zoneTriggerFires(never, ctx(reenteredAt < 0 ? 0 : reenteredAt / 1000))) neverFires++;
  if (reenteredAt < 0) {
    // Arm normally first, then "re-enter the state" at a moment the zone is definitely occupied.
    zoneTriggerFires(plainRule, ctx(0));
    if (occupied) reenteredAt = nowMs;
    return;
  }
  // From here the state was entered at `reenteredAt`, with somebody already inside the zone.
  if (!occupied) return;                       // they left — the rule is allowed to arm again
  framesTested++;
  if (zoneTriggerFires(plainRule, ctx(reenteredAt / 1000))) firedAfterReentry++;
});
console.log(`\n  re-entered the state at ${reenteredAt}ms with "${zBusy.name}" occupied;`
  + ` the 600s dwell fired ${neverFires}x, the plain rule fired ${firedAfterReentry}x over ${framesTested} occupied frames`);
check('a 600s dwell never fires inside a 34s take', neverFires === 0);
check('a rule does NOT fire on re-entry while its zone is still occupied', firedAfterReentry === 0,
  `fired ${firedAfterReentry}x — a memo shared with the 600s rule would re-arm it every frame`);
check('…and the test actually exercised that window', framesTested > 30, `only ${framesTested} frames`);

// ── 4. THE TAKE BOUNDARY — people must not survive it ───────────────────────────────────────────
// people.reset() was missing from the take-boundary reset until this branch. The tracker coasts a
// confirmed person for MAX_COAST_MS, so without it the frames after a take ends still carry people
// from inside it — and those are now what the zones count.
reset(true);
replay();
const before = allZones.reduce((n, z) => n + (zones.getState(z.id)?.count ?? 0), 0);
people.reset(); zones.reset(); resetZoneTriggers();
trackingStore.applySnapshot({ surfaces: [] });
nowMs += 20; people.refresh(nowMs); zones.evaluate(nowMs);
const after = allZones.reduce((n, z) => n + (zones.getState(z.id)?.count ?? 0), 0);
console.log(`\n  occupancy across a take boundary: ${before} -> ${after}`);
check('the take boundary clears every person', after === 0, `${after} left standing`);

console.log(failures ? `\n${failures} FAILED\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
