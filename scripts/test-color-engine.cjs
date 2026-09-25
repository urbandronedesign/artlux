// Does the colour engine solve the REAL fixture library, and does the rig then make that colour?
//
//   node scripts/test-color-engine.cjs
//
// `verify:invariants` reads source, so it can assert the engine still LOOKS right — that the emitter
// table has one owner, that the ternary in `roleValue` is intact. It cannot assert that asking an
// RGBWA+UV head for magenta produces magenta, and that is the entire job of this file. Numbers are
// where this code fails: a solver that stops iterating too early does not throw, does not fail to
// typecheck, and returns a plausible colour that is quietly 5% wrong.
//
// It is pure logic — `colorEngine` and `fixtureSignal.resolveFixture` touch no DOM, no GPU and no
// wire — so unlike scripts/test-lighting-take.cjs this needs no app, no CDP and about two seconds.
// The TypeScript is bundled on the fly with the esbuild that already ships in devDependencies.
//
// EVERY CASE GOES THROUGH `resolveFixture`. Comparing the solver against its own arithmetic would
// prove only that it is self-consistent; driving the app's own reader with the solver's output and
// comparing the colour that comes back is what makes it a round trip.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'resources', 'fixture-library');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'artlux-color-'));

// ── bundle the two services ──────────────────────────────────────────────────────────────────
const entry = path.join(WORK, 'entry.ts');
const bundle = path.join(WORK, 'bundle.cjs');
fs.writeFileSync(entry, `
export * from ${JSON.stringify(path.join(ROOT, 'src/renderer/services/colorEngine').replace(/\\/g, '/'))};
export { resolveFixture } from ${JSON.stringify(path.join(ROOT, 'src/renderer/services/fixtureSignal').replace(/\\/g, '/'))};
`, 'utf8');
try {
  execFileSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    entry, '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundle}`, '--log-level=error',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  console.error('could not bundle the colour engine:', e.stderr ? e.stderr.toString() : e.message);
  process.exit(1);
}
const E = require(bundle);

// ── the corpus ───────────────────────────────────────────────────────────────────────────────
const profiles = fs.readdirSync(LIB)
  .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'MANIFEST.json')
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(LIB, f), 'utf8')));
if (profiles.length < 100) { console.error(`only ${profiles.length} profiles — is the library built?`); process.exit(1); }

const TARGETS = [
  ['red', [1, 0, 0]], ['amber', [1, 0.65, 0.1]], ['yellow', [1, 1, 0]], ['green', [0, 1, 0]],
  ['cyan', [0, 1, 1]], ['blue', [0, 0, 1]], ['magenta', [1, 0, 1]], ['white', [1, 1, 1]],
  ['warm', [1, 0.82, 0.62]], ['pale blue', [0.7, 0.85, 1]], ['pink', [1, 0.6, 0.75]],
  ['deep purple', [0.35, 0, 0.7]], ['lavender', [0.8, 0.7, 1]],
];

const norm = (c) => { const p = Math.max(c[0], c[1], c[2]) || 1; return [c[0] / p, c[1] / p, c[2] / p]; };
const fixture = (p, modeKey, dmx) => ({
  id: 'f', name: 'f', startAddress: 1, universe: 0, ledCount: 1, profileId: p.id, profileMode: modeKey, dmx,
});

let failed = 0;
const note = (pass, what, detail) => {
  if (!pass) failed++;
  console.log(`   ${pass ? 'PASS ' : 'FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. every mixing mode in the library ──────────────────────────────────────────────────────
console.log('\n1. every additive mixing mode reproduces every reference colour');
let worst = 0; let worstWhere = ''; let checked = 0; let within = 0;
for (const p of profiles) {
  for (const m of p.modes) {
    const cap = E.colorCapability(p, m);
    if (cap.control !== 'mix' || cap.subtractive) continue;
    checked++;
    let modeWorst = 0;
    for (const [, target] of TARGETS) {
      const { values } = E.solveEmitters(cap, target);
      const dmx = {};
      for (const em of cap.emitters) dmx[em.channel.key] = values[em.role] ?? 0;
      const st = E.resolveFixture(fixture(p, m.key, dmx), p);
      const want = norm(target); const got = norm([st.r, st.g, st.b]);
      modeWorst = Math.max(modeWorst, ...[0, 1, 2].map((i) => Math.abs(want[i] - got[i])));
    }
    if (modeWorst < 0.02) within++;
    if (modeWorst > worst) { worst = modeWorst; worstWhere = `${p.id} · ${m.key}`; }
  }
}
console.log(`   ${checked} modes × ${TARGETS.length} colours, driven through resolveFixture`);
// 2% is below "an operator would notice"; the regression this catches is an under-converged fit,
// which lands at 5% and upwards. See the iteration table in colorEngine.
note(worst < 0.02, `all ${checked} modes within 2%`, `${within} within 2%, worst ${(worst * 100).toFixed(1)}% (${worstWhere})`);

// ── 2. gamut honesty ─────────────────────────────────────────────────────────────────────────
console.log('\n2. a fixture reports the colours it cannot make');
const byId = (id) => profiles.find((p) => p.id === id);
const cwww = byId('generic/cw-ww-2ch');
if (cwww) {
  const cap = E.colorCapability(cwww, cwww.modes[0]);
  note(cap.control === 'temperature', 'a CW/WW head is offered temperature, not a hue wheel', cap.control);
  note(E.solveEmitters(cap, [0, 1, 0]).error > 0.3, 'asking it for green reports a large error rather than a lie');
  const mid = E.solveTemperature(cap, 0.5);
  note((mid.warmWhite ?? 0) > 0.98 && (mid.coldWhite ?? 0) > 0.98, 'mid temperature runs both emitters at full');
} else {
  console.log('   (skipped — generic/cw-ww-2ch is not in the library)');
}

// ── 3. the control each family is offered ────────────────────────────────────────────────────
console.log('\n3. the control offered per family');
const counts = {};
for (const p of profiles) for (const m of p.modes) { const c = E.colorCapability(p, m).control; counts[c] = (counts[c] ?? 0) + 1; }
console.log(`   ${Object.entries(counts).sort().map(([k, v]) => `${k}:${v}`).join('  ')}`);
note((counts.mix ?? 0) > 500 && (counts.none ?? 0) > 200 && (counts.temperature ?? 0) > 100,
  'the four controls cover the library in the measured proportions');
const mac = byId('martin/mac-250-beam');
if (mac) {
  const cap = E.colorCapability(mac, mac.modes[0]);
  note(cap.control === 'mix' && cap.subtractive && cap.emitters.length === 0,
    'a CMY head is mixable, subtractive, and its flags are NOT in the emitter basis');
  const f = E.flagsForColor([1, 0, 0]);
  note(Math.abs(f.cyan) < 1e-6 && Math.abs(f.magenta - 1) < 1e-6, 'red on a CMY head = cyan out, magenta in');
}

// ── 4. the fade paths ────────────────────────────────────────────────────────────────────────
console.log('\n4. the fade paths');
const chroma = (c) => { const o = E.rgbToOklab(c); return Math.hypot(o[1], o[2]); };
const mid = (space) => norm(E.mixColor([1, 0, 0], [0, 1, 1], 0.5, space));
// The real defect in straight-line rgb, measured rather than assumed: COMPLEMENTARY colours wash out
// to white. (The folklore "rgb fades go dark" is about gamma-encoded screen colour; these are linear
// emitter values and the dimmer owns brightness, so red→blue is fine.)
note(chroma(mid('rgb')) < 0.01, 'straight-line rgb washes complementary colours out to white');
note(chroma(mid('hsv')) > 0.15 && chroma(mid('oklab')) > 0.03, 'hsv and oklab keep colour in the middle');
const PAIRS = [
  [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 1, 0]], [[0, 0, 1], [1, 0.82, 0.62]],
  [[0.35, 0, 0.7], [1, 0.65, 0.1]], [[1, 0, 0], [0, 1, 1]],
];
const evenness = (space) => Math.max(...PAIRS.map(([a, b]) => {
  const pts = [0, 0.25, 0.5, 0.75, 1].map((u) => E.rgbToOklab(norm(E.mixColor(a, b, u, space))));
  const steps = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1], q[2] - pts[i][2]));
  return Math.max(...steps) / Math.max(1e-6, Math.min(...steps));
}));
const ev = { rgb: evenness('rgb'), hsv: evenness('hsv'), oklab: evenness('oklab') };
console.log(`   worst step-ratio over ${PAIRS.length} pairs — rgb ${ev.rgb.toFixed(2)}  hsv ${ev.hsv.toFixed(2)}  oklab ${ev.oklab.toFixed(2)}`);
note(ev.oklab < ev.rgb && ev.oklab < ev.hsv, 'oklab changes at the most even perceived rate — why it is the default');
const wrap = E.mixColor([1, 0, 0], [1, 0, 0.3], 0.5, 'hsv');
note(wrap[0] > 0.9, 'a hue fade near the wrap point takes the short way round');

// ── 5. the memo ──────────────────────────────────────────────────────────────────────────────
console.log('\n5. the memo (the packer asks per CHANNEL, so a cold solve per call would be 4× per frame)');
const rgbw = byId('generic/rgbw-4ch') || profiles.find((p) => E.colorCapability(p, p.modes[0]).control === 'mix');
const t0 = process.hrtime.bigint();
for (let i = 0; i < 20000; i++) E.solveCached(rgbw, rgbw.modes[0], [1, 0.5, 0.25]);
const per = Number(process.hrtime.bigint() - t0) / 20000;
note(per < 2000, 'a repeated solve is a map lookup', `${(per / 1000).toFixed(2)} µs/call`);

fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) failed` : '\ncolour engine OK');
process.exit(failed ? 1 : 0);
