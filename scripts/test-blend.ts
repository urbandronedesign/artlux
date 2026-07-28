// A behavioural check over plugins/calibration/src/blendCompute.ts — the world-space multi-projector
// edge blend. Same idiom as test-docktree: blendCompute imports nothing, so `npm run test:blend`
// compiles this and runs it in about a second, with no Electron, no camera and no projectors.
//
// This exists because the blend is the one part of the auto-calibration story that CAN be proven
// without a rig. Two projectors overlapping on a wall must, at every surface point lit by both, have
// alphas that sum to 1 — a partition of unity. If they do not, the seam is a bright band (sum > 1) or
// a dark one (sum < 1), and no amount of geometric accuracy hides it. The docs claimed this had been
// "node-validated"; no such script was ever committed, so the claim could not be checked. Now it can.

import { computeBlendMaps, type ProjectorBlendInput, type BlendMap } from '../plugins/calibration/src/blendCompute';

let failed = 0;
const ok = (cond: boolean, what: string) => {
  if (cond) console.log(`  OK   ${what}`);
  else { console.log(`  FAIL ${what}`); failed++; }
};
const near = (a: number, b: number, tol: number, what: string) =>
  ok(Math.abs(a - b) <= tol, Math.abs(a - b) <= tol ? what : `${what}   (got ${a.toFixed(5)}, want ${b.toFixed(5)} ±${tol})`);

// A projector lighting an axis-aligned patch of a flat wall (z = 0), sampled on a regular grid.
// `x0..x1` is the world span it covers; the raster is the projector's own pixel grid over that span.
// This is exactly the shape solveGeometry produces: flat projector-pixel pairs + aligned world XYZ.
function wallProjector(surfaceId: string, x0: number, x1: number, raster: [number, number], n = 120): ProjectorBlendInput {
  const [pw, ph] = raster;
  const proj: number[] = [], world: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1), v = j / (n - 1);
      proj.push(u * (pw - 1), v * (ph - 1));
      world.push(x0 + u * (x1 - x0), v * 2.0, 0); // 2 m tall wall
    }
  }
  return { surfaceId, raster, denseMap: { proj, world } };
}

// Sample a blend map at normalized (u, v) BILINEARLY, because that is how it is actually consumed:
// the shader uploads it as a LinearFilter texture and nvwarpApply.sampleGrid does the same on the
// CPU. Asserting against nearest samples would be testing something no projector ever sees — and
// would fail on the intrinsic half-cell staircase, which the interpolation is there to remove.
// Texel-centre convention, matching both computeBlendMaps' binning and the two samplers.
const at = (m: BlendMap, u: number, v: number): number => {
  const fx = Math.max(0, Math.min(m.w - 1, Math.min(1, Math.max(0, u)) * m.w - 0.5));
  const fy = Math.max(0, Math.min(m.h - 1, Math.min(1, Math.max(0, v)) * m.h - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(m.w - 1, x0 + 1), y1 = Math.min(m.h - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  return m.data[y0 * m.w + x0] * (1 - tx) * (1 - ty) + m.data[y0 * m.w + x1] * tx * (1 - ty)
       + m.data[y1 * m.w + x0] * (1 - tx) * ty + m.data[y1 * m.w + x1] * tx * ty;
};

// The raw cell value — used only to hunt for the association bug, whose signature is a cell sitting
// at full alpha in the middle of a seam. Interpolation would smear exactly that away.
const cell = (m: BlendMap, u: number, v: number): number => {
  const x = Math.min(m.w - 1, Math.max(0, Math.round(u * (m.w - 1))));
  const y = Math.min(m.h - 1, Math.max(0, Math.round(v * (m.h - 1))));
  return m.data[y * m.w + x];
};

console.log('\n[two projectors, 25% overlap — the partition of unity]');
// A covers 0..4 m, B covers 3..7 m → a 1 m overlap in the middle of a 7 m wall.
const A = wallProjector('A', 0, 4, [1920, 1080]);
const B = wallProjector('B', 3, 7, [1920, 1080]);
const [mA, mB] = computeBlendMaps([A, B]);
// Diagnostic strip across the seam — printed always, because when the sum is wrong the SHAPE of the
// two ramps says immediately whether it is a ramp problem or an association problem.
console.log('  x       alphaA  alphaB  sum');
for (let k = 0; k <= 10; k++) {
  const x = 2.9 + k * 0.12;
  const a = x <= 4 ? at(mA, x / 4, 0.5) : 0;
  const b = x >= 3 ? at(mB, (x - 3) / 4, 0.5) : 0;
  console.log(`  ${x.toFixed(2)}m   ${a.toFixed(3)}   ${b.toFixed(3)}   ${(a + b).toFixed(3)}`);
}

ok(!!mA && !!mB, 'a map comes back for each projector');
ok(mA.surfaceId === 'A' && mB.surfaceId === 'B', 'maps are returned in input order, tagged by surface');
ok(mA.w > 4 && mA.h > 2, `the grid is not degenerate (${mA.w}x${mA.h})`);

// THE property. Walk the overlapping world band and assert the two projectors' shares sum to 1.
// World x in [3,4] is A's right quarter (u 0.75..1.0) and B's left quarter (u 0..0.25).
let worstSum = 1, worstDev = 0, worstAt = 0;
for (let k = 1; k < 20; k++) {
  const x = 3 + (k / 20); // 3.05 .. 3.95 m
  const sum = at(mA, (x - 0) / 4, 0.5) + at(mB, (x - 3) / 4, 0.5);
  if (Math.abs(sum - 1) > worstDev) { worstDev = Math.abs(sum - 1); worstSum = sum; worstAt = x; }
}
// WHY THE TOLERANCE IS NOT ZERO — and why that is a property, not a bug being waved through.
//
// Two projectors do not share a cell grid: at the same physical point their cells sit about half a
// cell apart, and a blend map that stores ONE alpha per cell cannot express that offset. The residual
// is therefore ~0.5/N, N being the overlap width in blend-map cells (here ~11 → ~4.5%). It is a
// smooth ramp error, not a step, and it shrinks with resolution — which the next check PROVES, so a
// real defect can never hide inside this tolerance by being called "quantization".
near(worstSum, 1, 0.06, `alphas sum to 1 across the whole overlap (worst ${worstSum.toFixed(4)} at x=${worstAt.toFixed(2)}m)`);

// The residual must be DISCRETIZATION: quadrupling the map resolution must shrink it. If the error
// stayed flat it would mean the ramps themselves are wrong, and no resolution would save the seam.
// Sample density must scale WITH the resolution — computeBlendMaps auto-sizes its grid to keep about
// 8 samples per cell, and forcing a finer grid than the scan can feed leaves holes that the
// morphological close then has to invent edges for. Testing mapW 96 against a 42-cell scan measures
// starvation, not resolution.
const devAt = (mapW: number): number => {
  const n = mapW * 3; // ~9 samples per cell
  const A = wallProjector('A', 0, 4, [1920, 1080], n);
  const B = wallProjector('B', 3, 7, [1920, 1080], n);
  const [a, b] = computeBlendMaps([A, B], { mapW });
  let dev = 0;
  for (let k = 1; k < 20; k++) {
    const x = 3 + k / 20;
    dev = Math.max(dev, Math.abs(at(a, x / 4, 0.5) + at(b, (x - 3) / 4, 0.5) - 1));
  }
  return dev;
};
// Both resolutions must put B's grid at the SAME phase relative to A's, or this measures alignment
// luck instead of resolution: B starts 3 m into A's 4 m span, so mapW 24 and 96 give 18 and 72 cells
// — exact alignment, no offset to resolve, a flatteringly small error for the wrong reason. 42 and
// 126 give 31.5 and 94.5: both half-offset, which is the honest worst case.
const coarse = devAt(42), fine = devAt(126);
const ratio = coarse / Math.max(fine, 1e-6);
ok(fine < coarse * 0.6, fine < coarse * 0.6
  ? `the residual is quantization: 3x the resolution cuts it ${ratio > 100 ? '>100' : ratio.toFixed(1)}x (mapW 42 ${(coarse * 100).toFixed(1)}% → 126 ${(fine * 100).toFixed(1)}%)`
  : `the residual does NOT shrink with resolution (${(coarse * 100).toFixed(1)}% → ${(fine * 100).toFixed(1)}%) — the ramps are wrong, not just coarse`);

// Away from the seam each projector owns all of its light, or none.
near(at(mA, 0.15, 0.5), 1, 0.02, 'A is at full alpha deep inside its own footprint');
near(at(mB, 0.85, 0.5), 1, 0.02, 'B is at full alpha deep inside its own footprint');
ok(at(mB, 0.0, 0.5) < at(mB, 0.5, 0.5), 'B ramps UP away from the seam edge it shares with A');
ok(at(mA, 1.0, 0.5) < at(mA, 0.5, 0.5), 'A ramps DOWN toward the seam edge it shares with B');

// Monotonicity: a ramp that wobbles is a visible mach band even when the sum is right.
let mono = true, monoAt = 0;
for (let i = 1; i < mA.w; i++) {
  const u0 = (i - 1) / (mA.w - 1), u1 = i / (mA.w - 1);
  if (u0 < 0.75) continue; // only inside the seam
  if (cell(mA, u1, 0.5) > cell(mA, u0, 0.5) + 1e-6) { mono = false; monoAt = u1 * 4; }
}
ok(mono, mono ? "A's alpha never rises again once it starts falling into the seam"
  : `A's alpha RISES again inside the seam (at x=${monoAt.toFixed(2)}m)`);

// THE ASSOCIATION BUG, guarded directly. Its signature is a raw cell sitting at (or near) full alpha
// inside the overlap: that projector's cell landed in a world voxel where its partner's cell did not,
// so it believed it was alone and kept all the light. On the wall it is a bright band. This is what
// the 3x3x3 dilation in computeBlendMaps exists to prevent — see the comment there.
let spike = 0, spikeAt = 0;
for (let k = 2; k < 18; k++) {
  const x = 3 + k / 20;                       // strictly inside the 3..4 m overlap
  for (const [m, u] of [[mA, x / 4], [mB, (x - 3) / 4]] as const) {
    const a = cell(m, u, 0.5);
    if (a > spike) { spike = a; spikeAt = x; }
  }
}
ok(spike < 0.99, spike < 0.99
  ? `no projector keeps full alpha inside the overlap (worst cell ${spike.toFixed(3)})`
  : `a cell holds alpha ${spike.toFixed(3)} at x=${spikeAt.toFixed(2)}m — it never found its partner`);

console.log('\n[black-lift weights]');
ok(!!mA.black && !!mB.black, 'a black-lift weight grid comes back when projectors overlap');
ok(mA.black!.every(v => v >= 0 && v <= 1), "A's black weights are all in 0..1");
near(at({ ...mA, data: mA.black! }, 0.15, 0.5), 1, 0.02,
  'black lift is FULL where this projector is alone — that is the region whose black must be raised');
near(at({ ...mA, data: mA.black! }, 0.95, 0.5), 0, 0.02,
  'black lift is ZERO in the deepest overlap, which already has two projectors of black');

console.log('\n[single projector — nothing to blend]');
const [solo] = computeBlendMaps([wallProjector('solo', 0, 4, [1920, 1080])], { voxel: 0.05 });
near(at(solo, 0.5, 0.5), 1, 1e-6, 'a lone projector keeps all of its light');
near(at(solo, 0.02, 0.5), 1, 1e-6, '...including at its own footprint edge — an outer border is not a seam');
ok(solo.black === undefined, 'no black-lift grid is emitted when there is no overlap to match');

console.log('\n[three projectors]');
// 0..3, 2.5..5.5, 5..8 → two overlaps, and the middle projector is in both.
const [t1, t2, t3] = computeBlendMaps([
  wallProjector('P1', 0, 3, [1920, 1080]),
  wallProjector('P2', 2.5, 5.5, [1920, 1080]),
  wallProjector('P3', 5, 8, [1920, 1080]),
], { voxel: 0.05 });
const sumAt = (x: number) => {
  let s = 0;
  if (x <= 3) s += at(t1, x / 3, 0.5);
  if (x >= 2.5 && x <= 5.5) s += at(t2, (x - 2.5) / 3, 0.5);
  if (x >= 5) s += at(t3, (x - 5) / 3, 0.5);
  return s;
};
near(sumAt(2.75), 1, 0.06, 'the first seam still sums to 1 with a third projector present');
near(sumAt(5.25), 1, 0.06, 'the second seam sums to 1 too');
near(sumAt(4.0), 1, 0.06, 'the middle projector owns all the light where it is alone');

console.log('\n[degenerate inputs must not throw]');
ok(computeBlendMaps([]).length === 0, 'no projectors → no maps');
let threw = false;
try {
  computeBlendMaps([{ surfaceId: 'empty', raster: [1920, 1080], denseMap: { proj: [], world: [] } }]);
} catch { threw = true; }
ok(!threw, 'a projector whose scan decoded nothing does not throw (it just lights nothing)');

console.log(failed ? `\n${failed} FAILURE(S)\n` : '\nall blend checks passed\n');
process.exit(failed ? 1 : 0);
