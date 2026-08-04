// Ground-truth test for the MANUAL calibration path — no projector, no camera, no venue.
//
// Manual mode's claim is: K built analytically from spec-sheet optics (throw ratio + lens shift) is
// good enough that solvePnP over hand-picked correspondences recovers the projector's real pose. That
// is testable without hardware: invent a pose, project known world points through the EXACT model the
// app uses, hand the resulting pixels back as if an operator had picked them, and see whether the
// solver returns the pose we started from.
//
// If this fails, no amount of careful aiming at a wall will save the manual flow.
const path = require('node:path');
const ROOT = process.env.ARTLUX_ROOT || process.cwd();
const calib = require(path.join(ROOT, 'native', 'calib', 'calib.node'));

// ── the app's own maths, transcribed (plugins/calibration/src/manualLens.ts) ──────────────────
const manualK = (tr, sh, sv, w, h) => [tr * w, 0, w * (0.5 + sh), 0, tr * w, h * (0.5 + sv), 0, 0, 1];
const lensFromK = (k, w, h) => ({ throwRatio: k[0] / w, shiftH: k[2] / w - 0.5, shiftV: k[5] / h - 0.5 });

// Forward projection under the full OpenCV model — the same expression reprojectionErrors() uses.
function project(K, dist, R, t, [X, Y, Z]) {
  const [k1, k2, p1, p2, k3] = dist;
  const xc = R[0] * X + R[1] * Y + R[2] * Z + t[0];
  const yc = R[3] * X + R[4] * Y + R[5] * Z + t[1];
  const zc = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  const x = xc / zc, y = yc / zc, r2 = x * x + y * y;
  const rad = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
  const xd = x * rad + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
  const yd = y * rad + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  return [K[0] * xd + K[2], K[4] * yd + K[5]];
}

const mul = (A, B) => { // 3x3 row-major
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return o;
};
const Rx = (a) => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const Ry = (a) => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];

// ⚠ THE CAMERA BASIS IS NOT A FREE CHOICE. OpenCV puts x right, y DOWN and z forward, so a rig in a
// Y-up world cannot simply "look along +Z": rows (1,0,0),(0,-1,0),(0,0,1) have determinant -1 — a
// reflection, not a rotation. The consistent frame looks along world -Z with the image y flipped,
// which is what BASE is. Building the pose with a plain euler() instead produced a scene whose pixels
// all fell off the raster while solvePnP still recovered the pose to 5e-8 — the algebra does not care
// which way the projector faces, and neither does an assertion that only checks the pose.
const BASE = [1, 0, 0, 0, -1, 0, 0, 0, -1];

let failures = 0;
const check = (name, ok, detail) => { console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

// ── 1. the lens round-trip ────────────────────────────────────────────────────────────────────
const W = 1920, H = 1080, TR = 1.5, SH = 0.0, SV = 0.5; // fully up-shifted fixed lens, the common case
const K = manualK(TR, SH, SV, W, H);
const back = lensFromK(K, W, H);
console.log('\nmanual lens');
check('throw ratio survives K', Math.abs(back.throwRatio - TR) < 1e-12, `${back.throwRatio}`);
check('lens shift survives K', Math.abs(back.shiftH - SH) < 1e-12 && Math.abs(back.shiftV - SV) < 1e-12, `h=${back.shiftH} v=${back.shiftV}`);
check('fx = TR·W by construction', Math.abs(K[0] - TR * W) < 1e-9, `fx=${K[0]}`);
check('principal point is shifted, not centred', Math.abs(K[5] - H * (0.5 + SV)) < 1e-9, `cy=${K[5]} (H=${H})`);

// ── 2. pose recovery from picked correspondences ──────────────────────────────────────────────
// A floor-standing projector 6 m back, lens 0.4 m up, yawed 5° and tilted up 2° — and it sits LOW on
// purpose: a fully up-shifted lens (shiftV = +0.5) puts the optical axis on the BOTTOM edge of the
// raster, so everything it lights is ABOVE the lens. A rig placed at 2.4 m with this lens would be
// throwing at the ceiling, which is exactly what the on-raster assertion caught.
const Rgt = mul(mul(Rx(2 * Math.PI / 180), Ry(5 * Math.PI / 180)), BASE);
const Cgt = [0.6, 0.4, 6.0];                                   // camera centre in world
const tgt = [-(Rgt[0] * Cgt[0] + Rgt[1] * Cgt[1] + Rgt[2] * Cgt[2]),
             -(Rgt[3] * Cgt[0] + Rgt[4] * Cgt[1] + Rgt[5] * Cgt[2]),
             -(Rgt[6] * Cgt[0] + Rgt[7] * Cgt[1] + Rgt[8] * Cgt[2])];
const dist = [0, 0, 0, 0, 0];                                  // a projector lens, modelled as ideal

// Points spread over a venue-sized volume, the way an operator picks distinct features.
// BUILT BACKWARDS, ON PURPOSE. Hand-placing world points and hoping they land on the raster failed
// twice (0/8, then 5/8) and each time the pose assertions passed anyway — so the scene is now derived
// from the pixels: choose eight targets spread across the projector's raster, cast each through the
// lens onto a plane, and take where it lands. Every pick is then on-raster by construction, and the
// remaining assertions are about the SOLVER rather than about my arithmetic.
function unproject(K, R, C, u, v, zPlane) {
  const dc = [(u - K[2]) / K[0], (v - K[5]) / K[4], 1];        // camera-space ray direction
  const d = [                                                  // world direction = Rᵀ · d_cam
    R[0] * dc[0] + R[3] * dc[1] + R[6] * dc[2],
    R[1] * dc[0] + R[4] * dc[1] + R[7] * dc[2],
    R[2] * dc[0] + R[5] * dc[1] + R[8] * dc[2],
  ];
  const s = (zPlane - C[2]) / d[2];                            // hit the plane z = zPlane
  return [C[0] + s * d[0], C[1] + s * d[1], C[2] + s * d[2]];
}
const TARGETS = [                                              // u, v, and which plane it lands on
  [140, 140, 0], [1780, 140, 0], [140, 940, 0], [1780, 940, 0],
  [620, 520, 0], [1300, 520, 0],
  [960, 300, 0.5], [500, 800, 0.4],                            // two features standing off the wall
];
const world = TARGETS.map(([u, v, z]) => unproject(K, Rgt, Cgt, u, v, z));
const pixels = world.map((w) => project(K, dist, Rgt, tgt, w));
const onRaster = pixels.filter(([u, v]) => u >= 0 && u < W && v >= 0 && v < H).length;

console.log('\npose recovery (8 picks, exact pixels)');
check('every synthetic pick lands on the raster', onRaster === world.length, `${onRaster}/${world.length}`);

const r = calib.solvePnp(world.flat(), pixels.flat(), K, dist);
const dR = Math.max(...r.rotation.map((v, i) => Math.abs(v - Rgt[i])));
const dC = (() => {                                            // compare CENTRES: what an operator sees
  const R = r.rotation, t = r.translation;
  const C = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]),
             -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]),
             -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2])];
  return Math.hypot(C[0] - Cgt[0], C[1] - Cgt[1], C[2] - Cgt[2]);
})();
check('rotation recovered', dR < 1e-3, `max |ΔR| = ${dR.toExponential(2)}`);
check('projector position recovered', dC < 1e-3, `Δ = ${(dC * 1000).toFixed(3)} mm`);
check('solver reports a near-zero RMS', r.rms < 0.05, `rms = ${r.rms.toFixed(4)} px`);

// ── 3. does it survive an operator's aim being imperfect? ─────────────────────────────────────
// Picks are made by eye against a projected crosshair, so ±2 px is optimistic-realistic.
const jitter = (seed) => { let s = seed; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff - 0.5) * 4; }; };
const j = jitter(7);
const noisy = pixels.map(([u, v]) => [u + j(), v + j()]);
const rn = calib.solvePnp(world.flat(), noisy.flat(), K, dist);
const Rn = rn.rotation, tn = rn.translation;
const Cn = [-(Rn[0] * tn[0] + Rn[3] * tn[1] + Rn[6] * tn[2]),
            -(Rn[1] * tn[0] + Rn[4] * tn[1] + Rn[7] * tn[2]),
            -(Rn[2] * tn[0] + Rn[5] * tn[1] + Rn[8] * tn[2])];
const dCn = Math.hypot(Cn[0] - Cgt[0], Cn[1] - Cgt[1], Cn[2] - Cgt[2]);
console.log('\nwith ±2 px aiming error on every pick');
check('position still within 5 cm', dCn < 0.05, `Δ = ${(dCn * 1000).toFixed(0)} mm, rms = ${rn.rms.toFixed(2)} px`);

// ── 4. the failure the flow is most likely to hit: a wrong spec sheet ─────────────────────────
// The operator types the throw ratio from the manual and it is 10% off. solvePnP has fixed K, so the
// error has to go somewhere — this measures WHERE, which is what the wizard's RMS is telling them.
const Kbad = manualK(TR * 1.1, SH, SV, W, H);
const rb = calib.solvePnp(world.flat(), pixels.flat(), Kbad, dist);
const Rb = rb.rotation, tb = rb.translation;
const Cb = [-(Rb[0] * tb[0] + Rb[3] * tb[1] + Rb[6] * tb[2]),
            -(Rb[1] * tb[0] + Rb[4] * tb[1] + Rb[7] * tb[2]),
            -(Rb[2] * tb[0] + Rb[5] * tb[1] + Rb[8] * tb[2])];
const dCb = Math.hypot(Cb[0] - Cgt[0], Cb[1] - Cgt[1], Cb[2] - Cgt[2]);
console.log('\nwith a 10% wrong throw ratio (the likely operator error)');
console.log(`    position error ${(dCb).toFixed(3)} m, reported rms ${rb.rms.toFixed(2)} px`);
check('a wrong lens shows up in the RMS the wizard displays', rb.rms > 1.0, `rms = ${rb.rms.toFixed(2)} px — the operator is warned`);

// ── 5. can pick geometry rescue a wrong lens? ─────────────────────────────────────────────────
// A focal error and a distance error look almost identical in reprojection when the picks are
// coplanar — the classic focal/depth ambiguity. Depth spread is the only thing that separates them,
// so this measures how much spread it takes before the RMS the operator is shown actually moves.
console.log('\ndoes depth spread let the RMS see a 10% lens error?');
const solveWith = (planes, trScale) => {
  const w = TARGETS.map(([u, v], i) => unproject(K, Rgt, Cgt, u, v, planes[i % planes.length]));
  const px = w.map((p) => project(K, dist, Rgt, tgt, p));
  const Kx = manualK(TR * trScale, SH, SV, W, H);
  const s = calib.solvePnp(w.flat(), px.flat(), Kx, dist);
  const R2 = s.rotation, t2 = s.translation;
  const C2 = [-(R2[0] * t2[0] + R2[3] * t2[1] + R2[6] * t2[2]),
              -(R2[1] * t2[0] + R2[4] * t2[1] + R2[7] * t2[2]),
              -(R2[2] * t2[0] + R2[5] * t2[1] + R2[8] * t2[2])];
  return { rms: s.rms, err: Math.hypot(C2[0] - Cgt[0], C2[1] - Cgt[1], C2[2] - Cgt[2]) };
};
// Mirrors plugins/calibration/src/manualLens.ts lensConstraint() — the thresholds under test.
const lensConstraint = (R, t, pts) => {
  const z = pts.map(([X, Y, Z]) => R[6] * X + R[7] * Y + R[8] * Z + t[2]);
  const near = Math.min(...z), far = Math.max(...z);
  const mean = z.reduce((a, b) => a + b, 0) / z.length;
  const spread = (far - near) / mean;
  return { spread, band: spread >= 0.2 ? 'ok' : spread >= 0.08 ? 'warn' : 'danger' };
};
const rows = [];
for (const [label, planes] of [
  ['all picks coplanar   ', [0]],
  ['0.5 m of depth spread', [0, 0.5]],
  ['2.0 m of depth spread', [0, 2.0]],
  ['4.0 m of depth spread', [0, 1.5, 3.0, 4.0]],
]) {
  const r = solveWith(planes, 1.1);
  const pts = TARGETS.map(([u, v], i) => unproject(K, Rgt, Cgt, u, v, planes[i % planes.length]));
  const g = lensConstraint(Rgt, tgt, pts);
  const rmsBand = r.rms < 2 ? '\x1b[32mok\x1b[0m' : r.rms < 5 ? '\x1b[33mwarn\x1b[0m' : '\x1b[31mdanger\x1b[0m';
  console.log(`    ${label}  off by ${r.err.toFixed(2)} m   rms ${r.rms.toFixed(2)} px → ${rmsBand}   depth spread ${(g.spread * 100).toFixed(0)}% → ${g.band}`);
  rows.push({ rms: r.rms, gauge: g.band });
}
// The gauge earns its place only if it flags precisely the cases the RMS misses.
const missedByRms = rows.filter((r) => r.rms < 2);
check('every case the RMS calls ok is flagged by the depth gauge',
  missedByRms.length > 0 && missedByRms.every((r) => r.gauge !== 'ok'),
  `${missedByRms.length} case(s) read ok on RMS; gauge says ${missedByRms.map((r) => r.gauge).join(', ')}`);
check('the gauge does not cry wolf once the RMS can see the error',
  rows.filter((r) => r.rms >= 5).every((r) => r.gauge === 'ok'),
  'spread-adequate cases are not warned about');
console.log('\n  ⚠ The pose RMS does NOT validate the lens. Coplanar picks hide a focal error almost');
console.log('    perfectly; only real depth spread makes it visible in the number the operator reads.');

console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m\n` : '\n\x1b[32mmanual calibration maths OK\x1b[0m\n');
process.exit(failures ? 1 : 0);
