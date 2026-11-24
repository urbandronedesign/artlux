#!/usr/bin/env node
// E3c — THE TIME EVALUATORS, TypeScript against Rust (plans/native-engine.md §4: "a parity harness compares TS
// and Rust evaluators on recorded shows before the TS path is deleted").
//
//   node scripts/test-eval-parity.cjs [--engine <artlux-engine.exe>] [project.artlux ...]
//
// The app's own evaluators (services/automation.ts segmentEase + sampleLane, types.ts clipFadeAlpha and the
// layerAlpha / clip-time formulas of timeline.ts) are BUNDLED from source with esbuild — not copied — and run on
// one list of cases; the engine runs the same list (`--eval-cases`, eval.rs). The cases:
//   - every curve kind the app knows (EASE_FN's own keys + linear / hold / bezier / an unknown name) on a dense
//     grid of u, beziers with random handles (overshooting, degenerate);
//   - random lanes (every kind, coincident keys, log targets) sampled before, across and after their keys;
//   - clips with fades (overlapping fades, zero-length, opacity > 1) across and beyond their span;
//   - RECORDED SHOWS: every automation lane and every timeline clip of every example project (and any project
//     given), each sampled across its whole span.
// Gate: |TS − Rust| ≤ 1e-9 on every value (pow / sin / cos may differ by an ulp between V8 and the C runtime).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ek = process.argv.indexOf('--engine');
const ENGINE = ek > 0 ? path.resolve(process.argv[ek + 1]) : path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} — npm run build:engine`); process.exit(2); }
const given = process.argv.slice(2).filter((a, i, all) => a.endsWith('.artlux') && all[i - 1] !== '--engine');

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'artlux-eval-parity-'));
// The app's evaluators, bundled from source (the formulas cannot drift from what the app runs).
const entry = path.join(WORK, 'entry.ts');
fs.writeFileSync(entry, `
export { segmentEase, sampleLane, EASE_FN } from ${JSON.stringify(path.join(ROOT, 'src/renderer/services/automation.ts'))};
export { clipFadeAlpha } from ${JSON.stringify(path.join(ROOT, 'src/renderer/types.ts'))};
`);
const bundle = path.join(WORK, 'evals.cjs');
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', external: ['electron'] });
const ts = require(bundle);

// A seeded generator, so a failure reproduces.
let seed = 0x5eed1234;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

const KINDS = [...Object.keys(ts.EASE_FN), 'linear', 'hold', 'bezier', 'notACurve', undefined];
const cases = [];
const label = [];
const add = (c, why) => { cases.push(c); label.push(why); };

// 1. Every curve kind on a dense grid (the edges included), and random beziers.
for (const k of KINDS) {
  if (k === 'hold') continue;   // hold is the caller's (sampleLane), not a fraction
  for (let i = 0; i <= 400; i++) add({ ease: k, u: i / 400 }, `ease ${k}`);
}
for (let n = 0; n < 300; n++) {
  const c = { ease: 'bezier', cx1: rnd(), cy1: rnd() * 3 - 1, cx2: rnd(), cy2: rnd() * 3 - 1 };
  if (n % 10 === 0) { c.cx1 = 0; c.cx2 = 1; }   // degenerate-ish x
  if (n % 13 === 0) { c.cx1 = 1; c.cx2 = 0; }
  for (let i = 0; i <= 50; i++) add({ ...c, u: i / 50 }, 'random bezier');
}
// 2. Random lanes.
const randomKey = (t) => {
  const k = { t, v: rnd() * 2 - 0.5 };
  const c = pick(KINDS);
  if (c !== undefined) k.curve = c;
  if (c === 'bezier' && rnd() < 0.7) Object.assign(k, { cx1: rnd(), cy1: rnd() * 2 - 0.5, cx2: rnd(), cy2: rnd() * 2 - 0.5 });
  return k;
};
for (let n = 0; n < 200; n++) {
  const len = 1 + Math.floor(rnd() * 12);
  let t = rnd() * 5 - 2;
  const keys = [];
  for (let i = 0; i < len; i++) { keys.push(randomKey(t)); t += rnd() < 0.15 ? 0 : rnd() * 3; }   // some coincident keys
  const log = n % 4 === 0;
  if (log) for (const k of keys) k.v = 20 + rnd() * 20000;   // a log target's min > 0
  const t0 = keys[0].t - 1, t1 = keys[keys.length - 1].t + 1;
  for (let i = 0; i <= 120; i++) add({ lane: keys, t: t0 + ((t1 - t0) * i) / 120, log }, 'random lane');
  for (const k of keys) add({ lane: keys, t: k.t, log }, 'random lane at a key');
}
// 3. Clips with fades.
for (let n = 0; n < 200; n++) {
  const duration = rnd() * 20;
  const clip = { start: rnd() * 30 - 5, inPoint: rnd() * 4, duration, fadeIn: rnd() < 0.3 ? 0 : rnd() * duration, fadeOut: rnd() < 0.3 ? 0 : rnd() * duration, opacity: rnd() < 0.5 ? 1 : rnd() * 1.4 };
  if (n % 7 === 0) delete clip.fadeIn;
  if (n % 9 === 0) delete clip.opacity;
  for (let i = 0; i <= 80; i++) add({ clip, ph: clip.start - 0.5 + ((duration + 1) * i) / 80 }, 'random clip');
}
// 4. Recorded shows.
const projects = [...given];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.artlux')) projects.push(p);
  }
})(path.join(ROOT, 'examples'));
let lanes = 0, clips = 0;
for (const file of projects) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  const tls = [p.timeline, ...(p.scenes ?? []).map((s) => s.timeline), ...Object.values(p.sceneTimelines ?? {})].filter((t) => t && typeof t === 'object');
  const name = path.relative(ROOT, file);
  for (const tl of tls) {
    for (const lane of tl.automation ?? []) {
      const keys = (lane.keyframes ?? []).filter((k) => Number.isFinite(k.t) && Number.isFinite(k.v));
      if (!keys.length) continue;
      lanes++;
      const t0 = keys[0].t - 1, t1 = keys[keys.length - 1].t + 1;
      for (let i = 0; i <= 600; i++) add({ lane: keys, t: t0 + ((t1 - t0) * i) / 600, log: false }, `${name} lane ${lane.targetPath}`);
    }
    for (const c of tl.clips ?? []) {
      if (!Number.isFinite(c.start) || !Number.isFinite(c.duration)) continue;
      clips++;
      const clip = { start: c.start, inPoint: c.inPoint ?? 0, duration: c.duration, fadeIn: c.fadeIn, fadeOut: c.fadeOut, opacity: c.content?.opacity };
      for (let i = 0; i <= 200; i++) add({ clip, ph: c.start + (c.duration * i) / 200 }, `${name} clip ${c.name ?? c.id}`);
    }
  }
}

// The app's values, by the app's functions (layerAlpha / nativeLayers' clip time, verbatim).
const tsOut = cases.map((c) => {
  if (c.lane) return ts.sampleLane(c.lane, c.t, { i: -1 }, c.log);
  if (c.clip) {
    const base = c.clip.opacity ?? 1;
    return [Math.max(0, Math.min(1, base * ts.clipFadeAlpha(c.clip, c.ph - c.clip.start))), c.ph - c.clip.start + (c.clip.inPoint ?? 0)];
  }
  const a = { curve: c.ease, cx1: c.cx1, cy1: c.cy1, cx2: c.cx2, cy2: c.cy2 };
  return ts.segmentEase(a, c.u);
});
// …and the same lanes through the app's frame-to-frame CURSOR, playing forward: the engine searches, the app
// walks — the answer must be the same.
const cursorOut = cases.map(() => null);
{
  let cur = { i: -1 }, prev = null;
  cases.forEach((c, i) => {
    if (!c.lane) return;
    if (c.lane !== prev) { cur = { i: -1 }; prev = c.lane; }
    cursorOut[i] = ts.sampleLane(c.lane, c.t, cur, c.log);
  });
}
const casesFile = path.join(WORK, 'cases.json');
fs.writeFileSync(casesFile, JSON.stringify(cases));
const rs = JSON.parse(execFileSync(ENGINE, ['--eval-cases', casesFile], { maxBuffer: 1 << 28 }).toString());

let failed = 0, worst = 0;
const flat = (v) => (Array.isArray(v) ? v : [v]);
for (let i = 0; i < cases.length; i++) {
  const a = flat(tsOut[i]), b = flat(rs[i]);
  for (let j = 0; j < a.length; j++) {
    const d = Math.abs(a[j] - b[j]);
    if (!(d <= 1e-9)) { if (failed++ < 12) console.log(`DIFF  ${label[i]}: ts ${a[j]} rust ${b[j]}  ${JSON.stringify(cases[i]).slice(0, 200)}`); }
    else worst = Math.max(worst, d);
  }
  if (cursorOut[i] !== null && cursorOut[i] !== tsOut[i]) { if (failed++ < 12) console.log(`CURSOR  ${label[i]}: walked ${cursorOut[i]} searched ${tsOut[i]}`); }
}
console.log(`${cases.length} cases (${KINDS.length} curve kinds; ${lanes} lanes and ${clips} clips from ${projects.length} projects); worst |ts − rust| ${worst.toExponential(2)}`);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\neval parity: ${failed} FAILED` : '\neval parity OK');
process.exit(failed ? 1 : 0);
