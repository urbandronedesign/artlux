// The two pure decision-makers of the unattended recalibration path, driven without a projector, a
// camera or a venue: `validateSolve` (may this replace the running calibration?) and `driftCheck`'s
// scoring (has this projector moved, and by how much on the surface?).
//
// Everything else in that path is IO. These two are where a wrong answer is expensive: one decides
// whether to overwrite a working show at 4am, the other decides whether to wake anybody up.

import { validateSolve, opticalCentre, rotationDeltaDeg, type Verdict } from '../plugins/calibration/src/validateSolve';
// driftSCORE, not driftCheck: the latter drives the projector and camera, so it is not runnable here.
import { matchProbes, aggregate, findBlobs, pickProbes, groupProbes } from '../plugins/calibration/src/driftScore';
import { defaultAutoRecalConfig, type ProjectorCalibration } from '../shared/protocol';
import type { MarkerlessResult } from '../plugins/calibration/src/markerlessController';
import type { DriftScore } from '../plugins/calibration/src/driftScore';

let failed = 0;
const ok = (cond: boolean, what: string) => {
  if (cond) console.log(`  OK   ${what}`);
  else { console.log(`  FAIL ${what}`); failed++; }
};
// `in` rather than !v.accept: this repo compiles without `strict`, where narrowing a union on a
// boolean-literal discriminant is not reliable. (plans/README.md: treat a green tsc as weaker
// evidence than it looks.)
const why = (v: Verdict): string | null => ('reason' in v ? v.reason : null);

const CFG = defaultAutoRecalConfig();

// A plausible 1080p projector: fx = fy = 2000 px (throw ratio ~1.04), centred, 4 m back, looking down +Z.
const baseCal = (over: Partial<ProjectorCalibration> = {}): ProjectorCalibration => ({
  intrinsics: [2000, 0, 960, 0, 2000, 540, 0, 0, 1],
  distortion: [0, 0, 0, 0, 0],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  translation: [0, 0, 4],
  imageSize: [1920, 1080],
  intrinsicsRms: 0.6, poseRms: 0.9,
  ...over,
});

const goodResult = (over: Partial<MarkerlessResult> = {}): MarkerlessResult => ({
  calibration: baseCal(),
  decoded: 20000, hits: 15000,
  cameraK: [1400, 0, 640, 0, 1400, 360, 0, 0, 1],
  selfCal: null,
  cameraPoseRms: 0.8,
  denseMap: { proj: [], world: [] },
  ...over,
});

const score = (rmsMm: number, matched = 150, expected = 160): DriftScore =>
  ({ matched, expected, rmsPx: rmsMm / 3, p95Px: rmsMm / 2, rmsMm, maxMm: rmsMm * 2 });

console.log('\n[the gate accepts only a solve that is better AND plausible]');
{
  const v = validateSolve(goodResult(), baseCal(), { candidate: score(2), incumbent: score(9) }, CFG);
  ok(v.accept, 'a clean solve that halves the drift is accepted');
}
{
  const v = validateSolve(goodResult(), baseCal(), { candidate: score(4.6), incumbent: score(5) }, CFG);
  ok(!v.accept && why(v) === 'not-better',
    'a marginal improvement is REFUSED — hysteresis, so nightly noise never churns a good calibration');
}
{
  // The incumbent is genuinely broken: now a valid candidate wins even without the 20% margin.
  const v = validateSolve(goodResult(), baseCal(), { candidate: score(7), incumbent: score(8) }, CFG);
  ok(v.accept, 'when the incumbent is already past the warn threshold, a valid candidate may take over');
}

console.log('\n[a LOW RESIDUAL IS NOT EVIDENCE OF A CORRECT SOLVE]');
{
  // THE case this whole module exists for: excellent numbers, tiny drift... and the projector has
  // apparently moved 80cm. It has not. The camera anchor is wrong, and applying this destroys the show.
  const moved = baseCal({ translation: [0, 0, 4.8] });
  const v = validateSolve(goodResult({ calibration: moved }), baseCal(),
    { candidate: score(0.4), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'implausible-pose-jump',
    'a 80cm pose jump is REJECTED even though its drift score is the best of any case here');
}
{
  const rot = Math.cos(10 * Math.PI / 180), s = Math.sin(10 * Math.PI / 180);
  const turned = baseCal({ rotation: [rot, 0, s, 0, 1, 0, -s, 0, rot] });
  const v = validateSolve(goodResult({ calibration: turned }), baseCal(),
    { candidate: score(0.5), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'implausible-pose-jump', 'a 10° rotation is rejected with an excellent score');
}
{
  const zoomed = baseCal({ intrinsics: [2400, 0, 960, 0, 2400, 540, 0, 0, 1] });
  const v = validateSolve(goodResult({ calibration: zoomed }), baseCal(),
    { candidate: score(0.5), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'implausible-optics', 'a 20% focal change is rejected — the lens did not change overnight');
}
{
  const squashed = baseCal({ intrinsics: [2000, 0, 960, 0, 2300, 540, 0, 0, 1] });
  const v = validateSolve(goodResult({ calibration: squashed }), null, { candidate: score(1), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'implausible-optics', 'non-square pixels are rejected even with no incumbent to compare to');
}
{
  const tele = baseCal({ intrinsics: [12000, 0, 960, 0, 12000, 540, 0, 0, 1] });
  const v = validateSolve(goodResult({ calibration: tele }), null, { candidate: score(1), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'implausible-optics', 'an absurd throw ratio is rejected');
}

console.log('\n[evidence and reference-frame gates]');
ok(!validateSolve(goodResult({ decoded: 400 }), baseCal(), { candidate: score(1), incumbent: score(9) }, CFG).accept,
  'a starved scan is rejected (the wizard floor of 50 is far too low unattended)');
ok(!validateSolve(goodResult({ hits: 200 }), baseCal(), { candidate: score(1), incumbent: score(9) }, CFG).accept,
  'too few rays hitting the venue is rejected');
ok(!validateSolve(goodResult({ decoded: 20000, hits: 6000 }), baseCal(), { candidate: score(1), incumbent: score(9) }, CFG).accept,
  'a poor hit RATE is rejected even when the absolute counts pass');
{
  const v = validateSolve(goodResult({ cameraPoseRms: 5 }), baseCal(), { candidate: score(1), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'bad-camera-anchor', 'a bad camera anchor is rejected first — everything downstream inherits it');
}
{
  const v = validateSolve(goodResult({ calibration: baseCal({ poseRms: 6 }) }), baseCal(),
    { candidate: score(1), incumbent: score(9) }, CFG);
  ok(!v.accept && why(v) === 'bad-solve', 'a high projector pose RMS is rejected');
}
{
  const v = validateSolve(
    goodResult({ selfCal: { ok: true, rms: 0.5, inliers: 900 }, cameraK: [1900, 0, 640, 0, 1900, 360, 0, 0, 1] }),
    baseCal(), { candidate: score(1), incumbent: score(9) }, CFG, 1400);
  ok(!v.accept && why(v) === 'selfcal-runaway', 'a self-cal that walked 36% off the stored camera profile is rejected');
}
{
  const v = validateSolve(goodResult(), baseCal(), { candidate: score(1, 80, 160), incumbent: score(9, 160, 160) }, CFG);
  ok(!v.accept && why(v) === 'coverage-loss', 'a solve that only saw half the reference probes cannot win');
}

console.log('\n[pose maths]');
{
  const C = opticalCentre([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 4]);
  ok(Math.abs(C[2] + 4) < 1e-9, 'optical centre of an identity-rotation pose at t=(0,0,4) is (0,0,-4)');
  const r = Math.cos(30 * Math.PI / 180), s = Math.sin(30 * Math.PI / 180);
  const d = rotationDeltaDeg([1, 0, 0, 0, 1, 0, 0, 0, 1], [r, -s, 0, s, r, 0, 0, 0, 1]);
  ok(Math.abs(d - 30) < 1e-6, `a 30° rotation measures as ${d.toFixed(4)}°`);
}

console.log('\n[drift scoring: a known shift must come back as that shift]');
{
  // Camera 3 m from a wall, fx 1500. A probe grid on the wall; blobs displaced by a known 6 px.
  const camK = [1500, 0, 640, 0, 1500, 360, 0, 0, 1];
  const camR = [1, 0, 0, 0, 1, 0, 0, 0, 1], camT: [number, number, number] = [0, 0, 3];
  const world: number[] = [];
  for (let i = 0; i < 20; i++) world.push((i % 5) * 0.2 - 0.4, Math.floor(i / 5) * 0.2 - 0.3, 0);
  // Where the camera would see them with no drift.
  const blobs = [];
  for (let i = 0; i < 20; i++) {
    const X = [world[i * 3], world[i * 3 + 1], world[i * 3 + 2]];
    const z = X[2] + camT[2];
    blobs.push({ x: 640 + (1500 * X[0]) / z + 6, y: 360 + (1500 * X[1]) / z, mass: 100 });
  }
  const s = aggregate([matchProbes({ world, blobs, camK, camDist: [0, 0, 0, 0, 0], camR, camT })]);
  ok(s.matched === 20, `all ${s.matched}/20 probes matched`);
  ok(Math.abs(s.rmsPx - 6) < 0.01, `a 6px displacement scores as ${s.rmsPx.toFixed(3)}px`);
  // 6px at depth 3m with fx 1500 → 6*3/1500 m = 12mm.
  ok(Math.abs(s.rmsMm - 12) < 0.1, `...and converts to ${s.rmsMm.toFixed(2)}mm on the surface (expected 12)`);
}
{
  // A probe whose blob is beyond the search radius must not be matched to a distant neighbour.
  const camK = [1500, 0, 640, 0, 1500, 360, 0, 0, 1];
  const s = aggregate([matchProbes({
    world: [0, 0, 0], blobs: [{ x: 640 + 200, y: 360, mass: 100 }],
    camK, camDist: [0, 0, 0, 0, 0], camR: [1, 0, 0, 0, 1, 0, 0, 0, 1], camT: [0, 0, 3], searchPx: 40,
  })]);
  ok(s.matched === 0 && s.expected === 1, 'a blob outside the search radius is not matched');
  ok(!Number.isFinite(s.rmsMm), 'nothing matched → an infinite score, which the policy reads as a gross fault');
}

console.log('\n[blob detection]');
{
  const w = 64, h = 48;
  const black = new Uint8Array(w * h).fill(12);      // an ambient-lit room, not a dark one
  const frame = new Uint8Array(w * h).fill(12);
  const put = (cx: number, cy: number) => {
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) frame[y * w + x] = 220;
  };
  put(10, 10); put(40, 30);
  black[5 * w + 5] = 250; frame[5 * w + 5] = 250;    // a standby LED: bright, but unchanged
  const blobs = findBlobs(frame, black, w, h);
  ok(blobs.length === 2, `found ${blobs.length} blobs, ignoring the always-on bright pixel`);
  const near = (b: { x: number; y: number }, x: number, y: number) => Math.hypot(b.x - x, b.y - y) < 0.5;
  ok(blobs.some(b => near(b, 10, 10)) && blobs.some(b => near(b, 40, 30)), 'centroids land on the dot centres');
}

console.log('\n[probe selection]');
{
  const proj: number[] = [], world: number[] = [];
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
    proj.push((x / 199) * 1920, (y / 199) * 1080);
    world.push(x * 0.01, y * 0.01, 0);
  }
  const p = pickProbes({ proj, world }, [1920, 1080], 160);
  const n = p.proj.length / 2;
  ok(n > 100 && n < 260, `picked ${n} probes for a target of 160`);
  const xs = p.proj.filter((_, i) => i % 2 === 0);
  ok(Math.min(...xs) < 200 && Math.max(...xs) > 1720,
    'probes span the full raster — a set clustered in the middle would score a rotation as no drift');
  const groups = groupProbes(p.proj, [1920, 1080]);
  const total = groups.reduce((s, g) => s + g.length, 0);
  ok(total === n, `every probe appears in exactly one time-multiplexed group (${groups.length} groups)`);
}

console.log(failed ? `\n${failed} FAILURE(S)\n` : '\nall recalibration checks passed\n');
process.exit(failed ? 1 : 0);
