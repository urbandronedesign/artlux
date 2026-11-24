#!/usr/bin/env node
// E3e — THE LIGHTING EVALUATORS, TypeScript against Rust (plans/native-engine.md §4: lighting takes and phase
// spread ported to Rust, "a parity harness compares TS and Rust evaluators on recorded shows before the TS path
// is deleted").
//
//   node scripts/test-light-eval-parity.cjs [--engine <artlux-engine.exe>] [project.artlux ...]
//
// The app's own evaluators — lightingTake.ts sampleRole / rolesOf / phaseOffset, lightingSequence.ts compile,
// colorSample.ts sampleColorLane, colorEngine.ts mixColor — are BUNDLED from source with esbuild (nothing copied)
// and run on one list of cases; the engine runs the same list (`--light-cases`, light.rs). The cases:
//   - phase spread: every mode, wings / blocks (fractional, < 1, missing), every index of totals 1–24;
//   - roles: random takes (1–4 parts, uneven roles), every generated-effect form, pose sequences (inline slots,
//     poseRef, a missing pose, roleCurves), clips with scale / offset / mirror / roleMask and every spread mode —
//     sampled for every fixture of the group before, across and past the take (it wraps);
//   - colour lanes: rgb / cct / palette refs (and a missing one), every path (rgb / hsv / oklab), eased, bezier,
//     overshooting (clamped), hold and coincident keys — sampled across and beyond; and mixColor on random pairs;
//   - RECORDED SHOWS: every lighting clip (its take, sequence and group) and colour lane of every example project
//     (and any project given), each sampled across its span for every fixture of its group.
// Gate: |TS − Rust| ≤ 1e-9 on every number (sin / cbrt / pow may differ by an ulp between V8 and the C runtime),
// the same undefined, the same role sets.
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

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'artlux-light-parity-'));
const src = (f) => JSON.stringify(path.join(ROOT, 'src/renderer/services', f));
const entry = path.join(WORK, 'entry.ts');
fs.writeFileSync(entry, `
export { sampleRole, rolesOf, phaseOffset } from ${src('lightingTake.ts')};
export { compile } from ${src('lightingSequence.ts')};
export { sampleColorLane } from ${src('colorSample.ts')};
export { mixColor } from ${src('colorEngine.ts')};
`);
const bundle = path.join(WORK, 'light.cjs');
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', external: ['electron'] });
const ts = require(bundle);

let seed = 0x11ad5eed;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CURVES = ['linear', 'hold', 'bezier', 'easeInOutSine', 'easeOutBack', 'easeInElastic', 'easeOutBounce', 'easeInCubic', undefined];
const ROLES = ['pan', 'tilt', 'dimmer', 'zoom', 'focus'];
const MODES = ['spread', 'wing', 'block', 'random', undefined, 'nonsense'];

const cases = [], label = [];
const add = (c, why) => { cases.push(c); label.push(why); };

const randomKeys = (n, t0, span, lo, hi) => {
  const out = []; let t = t0;
  for (let i = 0; i < n; i++) {
    const k = { t, v: lo + rnd() * (hi - lo) };
    const c = pick(CURVES); if (c) k.curve = c;
    if (c === 'bezier' && rnd() < 0.6) Object.assign(k, { cx1: rnd(), cy1: rnd() * 2 - 0.5, cx2: rnd(), cy2: rnd() * 2 - 0.5 });
    out.push(k); t += rnd() < 0.1 ? 0 : (span / n) * (0.3 + rnd());
  }
  return out;
};
const spread = () => {
  const s = {};
  if (rnd() < 0.8) s.phase = rnd() < 0.1 ? 0 : (rnd() - 0.3) * 0.8;
  const m = pick(MODES); if (m) s.phaseMode = m;
  if (rnd() < 0.5) s.wings = pick([1, 2, 3, 4, 0.5, 2.5, 0]);
  if (rnd() < 0.5) s.blocks = pick([1, 2, 3, 5, 0.5, 0]);
  return s;
};

// 1. Phase spread.
for (let n = 0; n < 120; n++) {
  const s = spread();
  for (let total = 1; total <= 24; total += pick([1, 3, 5])) for (let i = 0; i < total; i++) add({ phase: s, index: i, total }, 'phase');
}

// 2. Lighting roles.
const randomTake = () => {
  const parts = [];
  const np = 1 + Math.floor(rnd() * 4);
  const duration = 0.5 + rnd() * 8;
  for (let p = 0; p < np; p++) {
    const channels = {};
    for (const r of ROLES) if (rnd() < 0.6) channels[r] = randomKeys(1 + Math.floor(rnd() * 8), 0, duration, r === 'pan' ? -270 : 0, r === 'pan' ? 270 : 1);
    parts.push({ channels });
  }
  return { version: 1, id: 'tk', name: 'take', duration: rnd() < 0.05 ? 0 : duration, parts };
};
const randomSeq = (poses) => {
  const keys = []; let t = 0;
  const nk = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < nk; i++) {
    const k = { t, slots: [] };
    if (rnd() < 0.3 && poses.length) k.poseRef = rnd() < 0.85 ? pick(poses).id : 'missing-pose';
    else { const ns = 1 + Math.floor(rnd() * 3); for (let s = 0; s < ns; s++) { const pose = {}; for (const r of ROLES) if (rnd() < 0.6) pose[r] = r === 'pan' ? rnd() * 540 - 270 : rnd(); k.slots.push(pose); } }
    const c = pick(CURVES); if (c) k.curve = c;
    if (rnd() < 0.3) k.roleCurves = { [pick(ROLES)]: pick(CURVES.filter(Boolean)) };
    if (rnd() < 0.3) Object.assign(k, { cx1: rnd(), cy1: rnd(), cx2: rnd(), cy2: rnd() });
    keys.push(k); t += rnd() < 0.1 ? 0 : rnd() * 3;
  }
  return { version: 1, id: 'sq', name: 'seq', duration: t + rnd() * 2, keys };
};
const randomPoses = () => Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, slots: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({ pan: rnd() * 360 - 180, dimmer: rnd() })) }));
const randomClip = (kind) => {
  const c = { ...spread() };
  if (kind === 'effect' || rnd() < 0.2) c.effect = { form: pick(['sine', 'triangle', 'ramp', 'square', 'random', 'other']), role: pick(ROLES), centre: rnd() * 100 - 50, amplitude: rnd() * 60, periodSec: pick([0, -1, 0.5, 2, 7.3]) };
  if (rnd() < 0.3) c.mirror = true;
  if (rnd() < 0.3) c.scale = pick([0, 0.5, 1, 1.7, -1]);
  if (rnd() < 0.3) c.offset = rnd() * 20 - 10;
  if (rnd() < 0.2) c.roleMask = ROLES.filter(() => rnd() < 0.5);
  return c;
};
const roleCases = (ctx, why, times) => {
  add({ roles: ctx }, `${why} roles`);
  for (let i = 0; i < ctx.total; i++) for (const t of times) for (const role of [...ROLES, 'colorWheel']) add({ role: { ...ctx, localTime: t, index: i, role } }, why);
};
for (let n = 0; n < 160; n++) {
  const kind = pick(['take', 'effect', 'seq']);
  const poses = randomPoses();
  const ctx = { clip: randomClip(kind), total: 1 + Math.floor(rnd() * 7) };
  if (kind === 'take') ctx.take = randomTake();
  if (kind === 'seq') { ctx.seq = randomSeq(poses); ctx.poses = poses; }
  const times = Array.from({ length: 14 }, (_, i) => -2 + i * 1.1 + rnd() * 0.3);
  roleCases(ctx, `random ${kind} clip`, times);
}

// 3. Colour lanes and mixes.
const randomColor = (pal) => {
  const r = rnd();
  if (r < 0.5) return { kind: 'rgb', rgb: [rnd() * 1.2, rnd(), rnd()] };
  if (r < 0.8) return { kind: 'cct', t: rnd() * 1.4 - 0.2 };
  return { kind: 'ref', id: rnd() < 0.85 && pal.length ? pick(pal).id : 'missing-colour' };
};
for (let n = 0; n < 160; n++) {
  const palette = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, name: `c${i}`, value: rnd() < 0.5 ? { kind: 'rgb', rgb: [rnd(), rnd(), rnd()] } : { kind: 'cct', t: rnd() } }));
  const keys = []; let t = rnd() * 2;
  const nk = 1 + Math.floor(rnd() * 6);
  for (let i = 0; i < nk; i++) {
    const k = { t, value: randomColor(palette) };
    const c = pick(CURVES); if (c) k.curve = c;
    if (c === 'bezier') Object.assign(k, { cx1: rnd(), cy1: rnd() * 2 - 0.5, cx2: rnd(), cy2: rnd() * 2 - 0.5 });
    const sp = pick(['rgb', 'hsv', 'oklab', undefined]); if (sp) k.space = sp;
    keys.push(k); t += rnd() < 0.1 ? 0 : rnd() * 2;
  }
  const lane = { id: 'L', keys, ...(rnd() < 0.05 ? { enabled: false } : {}) };
  for (let i = 0; i <= 60; i++) add({ color: lane, t: keys[0].t - 1 + ((t + 2 - keys[0].t) * i) / 60, palette }, 'random colour lane');
}
for (let n = 0; n < 2000; n++) add({ mix: [[rnd() * 1.3, rnd(), rnd()], [rnd(), rnd() * 1.3, rnd()]], u: rnd() * 1.4 - 0.2, space: pick(['rgb', 'hsv', 'oklab']) }, 'mixColor');

// 4. Recorded shows.
const projects = [...given];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.artlux')) projects.push(p);
  }
})(path.join(ROOT, 'examples'));
let recClips = 0, recLanes = 0;
for (const file of projects) {
  let p; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  const name = path.relative(ROOT, file);
  const groups = p.groups ?? [], poses = p.lightingPoses ?? [], palette = p.colorPalette ?? [];
  const tls = [p.timeline, ...(p.scenes ?? []).map((s) => s.timeline)].filter((t) => t && typeof t === 'object');
  for (const tl of tls) {
    for (const c of tl.clips ?? []) {
      if (c.kind !== 'lighting' || !c.lighting) continue;
      const l = c.lighting;
      const take = l.takeId ? (tl.lightingTakes ?? []).find((t) => t.id === l.takeId) : undefined;
      const seq = l.sequenceId ? (tl.lightingSequences ?? []).find((s) => s.id === l.sequenceId) : undefined;
      if (take && !take.parts) continue;   // a take kept in a sidecar: not readable here
      const g = groups.find((x) => x.id === l.groupId);
      const total = g ? g.fixtureIds.length : 1;
      recClips++;
      const ctx = { clip: l, total, ...(take ? { take } : {}), ...(seq ? { seq, poses } : {}) };
      roleCases(ctx, `${name} clip ${c.name ?? c.id}`, Array.from({ length: 40 }, (_, i) => (c.inPoint ?? 0) + (c.duration * i) / 40));
    }
    for (const lane of tl.colorLanes ?? []) {
      if (!lane.keys?.length) continue;
      recLanes++;
      const a = lane.keys[0].t - 1, b = lane.keys[lane.keys.length - 1].t + 1;
      for (let i = 0; i <= 200; i++) add({ color: lane, t: a + ((b - a) * i) / 200, palette }, `${name} colour lane ${lane.id}`);
    }
  }
}

// The app's answers, by the app's functions.
const tsOut = cases.map((c) => {
  if (c.role) {
    const r = c.role;
    const sequence = r.seq ? ts.compile(r.seq, r.poses) : undefined;
    return ts.sampleRole({ clip: r.clip, take: r.take, sequence, localTime: r.localTime, index: r.index, total: r.total }, r.role, { i: -1 }) ?? null;
  }
  if (c.roles) { const r = c.roles; return ts.rolesOf(r.clip, r.take, r.seq ? ts.compile(r.seq, r.poses) : undefined).sort(); }
  if (c.phase) return ts.phaseOffset(c.phase, c.index, c.total);
  if (c.color) return ts.sampleColorLane(c.color, c.t, undefined, c.palette) ?? null;
  if (c.mix) return [...ts.mixColor(c.mix[0], c.mix[1], c.u, c.space)];
  return null;
});
const casesFile = path.join(WORK, 'cases.json');
fs.writeFileSync(casesFile, JSON.stringify(cases));
const rs = JSON.parse(execFileSync(ENGINE, ['--light-cases', casesFile], { maxBuffer: 1 << 28 }).toString());

let failed = 0, worst = 0, compared = 0;
// Deep compare: numbers within 1e-9 (both NaN counts as equal — JSON carries NaN as null on both sides).
const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') { const d = Math.abs(a - b); if (d <= 1e-9) { worst = Math.max(worst, d); return true; } return Number.isNaN(a) && Number.isNaN(b); }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b || (a === null && typeof b === 'number' && Number.isNaN(b));
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
};
const jsonish = (v) => JSON.parse(JSON.stringify(v ?? null));   // NaN → null, as the engine's side went through JSON
for (let i = 0; i < cases.length; i++) {
  compared++;
  if (!same(jsonish(tsOut[i]), rs[i])) { if (failed++ < 12) console.log(`DIFF  ${label[i]}: ts ${JSON.stringify(jsonish(tsOut[i]))} rust ${JSON.stringify(rs[i])}  ${JSON.stringify(cases[i]).slice(0, 240)}`); }
}
console.log(`${compared} cases (${recClips} lighting clips and ${recLanes} colour lanes from ${projects.length} projects); worst |ts − rust| ${worst.toExponential(2)}`);
fs.rmSync(WORK, { recursive: true, force: true });
console.log(failed ? `\nlight eval parity: ${failed} FAILED` : '\nlight eval parity OK');
process.exit(failed ? 1 : 0);
