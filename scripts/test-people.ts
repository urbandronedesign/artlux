// Does a venue person made of TWO blobs count as one? Run: npm run test:people
//
// This is the test that was missing. The installed LiDAR reports ~2 blobs per person, each with its
// own id, so every raw count doubles — a zone asking for two visitors needed four. The merge existed
// and was correct; what did not exist was anything that ran it against a paired feed, so nothing
// contradicted the assumption that a blob was a person. It is checked here because it is pure: one
// second, no Electron, no app, no sensor.
//
// Mirrors what `scripts/lidar-emitter.cjs --pairs` puts on the wire: each person emits two blobs
// 0.3 m apart (HALF_GAP_M 0.15 either side), well inside the 0.8 m default merge radius.
import { clusterBlobs, clusterAndTrack, resetPeopleTracking } from '../plugins/lidar-tracking/src/blobClustering';
import type { Blob, TrackingSnapshot } from '../plugins/lidar-tracking/src/trackingStore';

const SCALE_X = 5.825, SCALE_Y = 3.125;
const RADIUS = 0.8;          // the shipped default merge radius
const HALF_GAP = 0.15;       // the emitter's --pairs offset → 0.3 m between a person's two blobs

let failures = 0;
const check = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

let slot = 0;
const blob = (tx: number, ty: number): Blob => {
  const s = slot++;
  // Each blob carries its OWN id — the venue's behaviour, and the whole reason a raw count doubles.
  return { slot: s, id: s + 1, tx, ty, u: tx / SCALE_X + 0.5, v: ty / SCALE_Y + 0.5, updatedAt: 0 };
};
// One person as the venue reports them: two blobs straddling their position.
const person = (tx: number, ty: number): Blob[] => [blob(tx - HALF_GAP, ty), blob(tx + HALF_GAP, ty)];
const surf = (blobs: Blob[]): TrackingSnapshot => ({ surfaces: [{ surface: 'SOL', scaleX: SCALE_X, scaleY: SCALE_Y, blobs }] });

// ── 1. The reported defect, reproduced and fixed ────────────────────────────────────────────────
slot = 0;
const twoPeople = [...person(-1.5, 0), ...person(1.5, 0)];
check('two people arrive as four blobs', twoPeople.length, 4);
check('…and merge back into two', clusterBlobs(twoPeople, RADIUS).length, 2);
// The bug, stated: with merging off the count is the blob count, so a zone set to 2 latches for ONE
// visitor and a zone meaning "two people" has to be typed as 4.
check('…but count 4 with merging off', twoPeople.length, 4);

// ── 2. The radius is a real boundary, not a rubber stamp ────────────────────────────────────────
// Two people standing 1.0 m apart must stay two, or merging would UNDER-count a close-standing pair —
// which is exactly why merging is off by default rather than simply assumed.
slot = 0;
check('two people 1.0 m apart stay two', clusterBlobs([blob(-0.5, 0), blob(0.5, 0)], RADIUS).length, 2);
slot = 0;
check('one person 0.3 m apart becomes one', clusterBlobs(person(0, 0), RADIUS).length, 1);

// ── 3. The tracker agrees — this is what zones now count ────────────────────────────────────────
// zones read people.ts, which runs clusterAndTrack: cluster, then confirm over CONFIRM_HITS frames.
// A track is only emitted as a person after 4 hits, so the first frames legitimately report nobody.
resetPeopleTracking();
slot = 0;
const walkers = [...person(-1.5, 0), ...person(1.5, 0)];
let now = 0;
const seen: number[] = [];
for (let f = 0; f < 8; f++) { now += 16.7; seen.push(clusterAndTrack(surf(walkers), RADIUS, now).surfaces[0].blobs.length); }
check('tracker confirms after CONFIRM_HITS frames', seen.slice(0, 3), [0, 0, 0]);
check('…then reports two people, steadily', seen.slice(4), [2, 2, 2, 2]);

// ── 4. A blob dropout does not drop the person ──────────────────────────────────────────────────
// The venue feed's ids flicker with a ~0.13 s median lifetime. Losing one of a person's two blobs must
// not halve the headcount — the reason zones read the TRACKER and not the bare spatial merge.
slot = 0;
const oneBlobEach = [walkers[0], walkers[2]];   // one blob per person survives this frame
now += 16.7;
check('a half-lost pair is still two people', clusterAndTrack(surf(oneBlobEach), RADIUS, now).surfaces[0].blobs.length, 2);

// ── 5. THE WALL: a blob is a HAND, and must never merge ─────────────────────────────────────────
// The floor sees legs (two blobs per visitor); the wall sees hands, one raised per visitor. A single
// project-wide merge flag could not say that, so turning merging on for the floor merged the wall too
// and two people touching near each other became ONE trigger. Radius 0 is how a surface opts out —
// and it must still TRACK, so a hand the sensor loses for a frame does not drop the trigger.
resetPeopleTracking();
slot = 0;
// Two people at the wall, hands 0.4 m apart — closer than the 0.8 m floor radius, so the floor's
// setting would have merged them.
const hands = [blob(-0.2, 0), blob(0.2, 0)];
check('two hands 0.4 m apart WOULD merge at the floor radius', clusterBlobs(hands, RADIUS).length, 1);
check('…but stay two at radius 0', clusterBlobs(hands, 0).length, 2);
now = 0;
let handsSeen = 0;
for (let f = 0; f < 8; f++) { now += 16.7; handsSeen = clusterAndTrack(surf(hands), 0, now).surfaces[0].blobs.length; }
check('…and the wall still tracks them as two', handsSeen, 2);
// The point of tracking rather than raw: one hand flickers out for a frame and must not drop.
now += 16.7;
check('a hand lost for one frame is still counted', clusterAndTrack(surf([hands[0]]), 0, now).surfaces[0].blobs.length, 2);

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
