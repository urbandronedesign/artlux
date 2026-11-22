#!/usr/bin/env node
// E1b PARITY: the native engine's universe packing (engine/artlux-engine/src/pack.rs) against the app's
// own (src/renderer/engine/packUniverses.ts), BYTE FOR BYTE (plans/native-engine.md §8 risk 2: two engines
// must agree before a source flips).
//
//   node scripts/test-pack-parity.cjs [more.artlux …]
//
// The TypeScript side is the REAL module, bundled with esbuild — not a re-implementation. The Rust side is
// `artlux-engine --pack-batch`. Both get the same inputs:
//   - every examples/**/*.artlux rig, plus any project named on the command line (a venue's real rig),
//     under several output defaults and gammas;
//   - SYNTHETIC rigs built to hit every rule: universe spill past 512, 3 and 4 channels per pixel, all six
//     colour orders, Art-Net / sACN / USB (enttec, port as the address), per-fixture output overrides
//     including "" (JavaScript `||` treats it as absent, `??` does not), priority 0, sparse, controllers
//     missing, LOOSE TYPES (a protocol of 0, broadcast "yes", channelsPerPixel "4"), lights mixed in, and a
//     canonical buffer SHORTER than the patch, or of a length that is not a multiple of 4 (the packer
//     must stop, not read past it).
// Light fixtures' bytes are a fixed pattern of their real footprint, identical on both sides — the host
// evaluates a light, the engine only places its bytes (§4).
// And the gamma LUT on its own, for a sweep of gammas: the one place where JavaScript's Math.pow and
// Rust's powf could round differently.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const WORK = path.join(os.tmpdir(), 'artlux-pack-parity');
fs.mkdirSync(WORK, { recursive: true });
if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} — npm run build:engine`); process.exit(2); }

// ── the TypeScript side, bundled from the real sources ─────────────────────────────────────────────────
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const bundle = path.join(WORK, 'pack-ts.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export { packUniverses, buildGammaLut } from './src/renderer/engine/packUniverses';
               export { fixtureFootprint } from './src/renderer/services/addressing';
               export { isLight } from './src/renderer/services/fixtureKind';`,
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
});
const TS = require(bundle);

// ── a deterministic PRNG, so a failure reproduces ──────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ORDERS = ['RGB', 'RBG', 'GRB', 'GBR', 'BRG', 'BGR'];

// `shortBy` LEDs fewer than the patch needs, and `ragged` bytes off the end (a length that is not a
// multiple of 4 — the GPU never hands one over, but the guard must hold if anything ever does).
function rawFor(fixtures, seed, shortBy = 0, ragged = 0) {
  const leds = fixtures.reduce((a, f) => a + Math.max(0, f.ledCount | 0), 0);
  const n = Math.max(0, (leds - shortBy) * 4 - ragged);
  const r = rng(seed), raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = Math.floor(r() * 256);
  return raw;
}

/** One case for both sides. Lights get pattern bytes of their footprint (0 when unresolved). */
function makeCase(name, fixtures, controllers, defaults, gamma, raw, profiles) {
  const profileMap = new Map(Object.entries(profiles || {}));
  const lightBytes = new Map();
  for (const f of fixtures) {
    if (!TS.isLight(f)) continue;
    const n = TS.fixtureFootprint(f, profileMap);
    lightBytes.set(f.id, Array.from({ length: n }, (_, k) => (k * 37 + f.id.length * 11) & 255));
  }
  return { name, fixtures, controllers, defaults, gamma, raw, lightBytes };
}

function runTs(c) {
  const pool = {};
  const dests = TS.packUniverses(c.raw, c.fixtures, {
    controllerMap: new Map(c.controllers.map((x) => [x.id, x])),
    defaults: c.defaults,
    gammaLut: TS.buildGammaLut(c.gamma),
    pool,
    packLight: (f, writeCh) => { for (const v of c.lightBytes.get(f.id) || []) writeCh(v); },
  });
  return canon(Object.entries(dests).map(([key, d]) => ({
    key, ip: d.ip, protocol: d.protocol, broadcast: d.broadcast, sparse: d.sparse,
    priority: d.priority === undefined ? null : d.priority,
    universes: Object.fromEntries(Object.entries(d.universes).map(([u, arr]) => [u, Array.from(arr)])),
  })));
}
// Both sides canonicalised: destinations in order, universes sorted numerically.
function canon(dests) {
  return dests.map((d) => ({
    ...d,
    universes: Object.keys(d.universes).map(Number).sort((a, b) => a - b).map((u) => [u, d.universes[u]]),
  }));
}
function toRust(c) {
  return {
    name: c.name, defaults: c.defaults, gamma: c.gamma, controllers: c.controllers, raw: Array.from(c.raw),
    fixtures: c.fixtures.map((f) => ({ ...f, light: TS.isLight(f), lightChannels: c.lightBytes.get(f.id) || [] })),
  };
}

// ── the cases ──────────────────────────────────────────────────────────────────────────────────────────
const cases = [];
const DEFAULTS = [
  { protocol: 'artnet', ip: '10.0.0.50', broadcast: false },
  { protocol: 'sacn', ip: '', broadcast: true },
];
const GAMMAS = [1, 2.2];

const projects = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.artlux') ? [path.join(d, e.name)] : []);
for (const f of walk(path.join(ROOT, 'examples'))) projects.push(f);
for (const a of process.argv.slice(2)) projects.push(path.resolve(a));
let projectCount = 0;
for (const file of projects) {
  let p;
  try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.log(`skip ${file}: ${e.message}`); continue; }
  const fixtures = p.fixtures || [];
  if (!fixtures.length) continue;
  projectCount++;
  for (const def of DEFAULTS) for (const g of GAMMAS) {
    cases.push(makeCase(`${path.relative(ROOT, file)} [${def.protocol}, γ${g}]`, fixtures, p.controllers || [], def, g, rawFor(fixtures, cases.length + 1), p.fixtureProfiles));
  }
}

// Synthetic rigs.
const r = rng(20261122);
const pick = (xs) => xs[Math.floor(r() * xs.length)];
const strOpt = () => pick([undefined, '', 'x']);
for (let k = 0; k < 400; k++) {
  const controllers = [];
  const nc = Math.floor(r() * 4);
  for (let c = 0; c < nc; c++) {
    // Loose types too (a protocol of 0, a broadcast of "yes"): files in the wild hold what the app tolerated.
    const proto = pick(['artnet', 'sacn', 'enttec', '', undefined, 0, 1]);
    controllers.push({
      id: `c${c}`, name: `C${c}`, protocol: proto,
      ip: pick([undefined, '', `10.0.${c}.${Math.floor(r() * 250)}`]),
      broadcast: pick([undefined, true, false, 0, 'yes', null]),
      port: proto === 'enttec' ? pick(['COM3', 'COM4', '', undefined]) : pick([undefined, '']),
      priority: pick([undefined, 0, 100, 150]),
    });
  }
  const fixtures = [];
  const nf = 1 + Math.floor(r() * 12);
  for (let i = 0; i < nf; i++) {
    const light = r() < 0.15;
    const f = {
      id: `f${k}_${i}`, name: `F${i}`, x: 0, y: 0, width: 0.1, height: 0.01, rotation: 0, reverse: false, colorData: [],
      universe: Math.floor(r() * 6),
      startAddress: 1 + Math.floor(r() * 512),
      ledCount: light ? 1 : pick([0, 1, 30, 170, 171, 300, 512]),
      channelsPerPixel: pick([undefined, 3, 4, '4', null]),
      colorOrder: pick([undefined, ...ORDERS]),
      controllerId: pick([undefined, ...controllers.map((c) => c.id), 'missing']),
    };
    if (r() < 0.35) {
      const proto = pick([undefined, '', 'artnet', 'sacn', 'enttec']);
      f.output = { protocol: proto, ip: strOpt() === 'x' ? `192.168.1.${i}` : strOpt(), broadcast: pick([undefined, true, false]),
        port: proto === 'enttec' ? pick(['COM9', '', undefined]) : undefined, priority: pick([undefined, 0, 50]), sparse: pick([undefined, true, false, 1, 'x', 0]) };
    }
    if (light) f.profileId = pick(['generic/dimmer', 'unknown/head']);
    fixtures.push(f);
  }
  // Profiles for the lights: one resolvable (footprint 1..40), one unresolved (footprint 0).
  const fp = 1 + Math.floor(r() * 40);
  const profiles = { 'generic/dimmer': { id: 'generic/dimmer', name: 'Dimmer', modes: [{ key: 'm', name: 'm', footprint: fp, channels: [] }] } };
  const def = pick([...DEFAULTS, { protocol: 'enttec', ip: '', broadcast: false }]);
  const g = pick([1, 0.45, 1.8, 2.2, 2.4, 2.6, 3]);
  const shortBy = r() < 0.2 ? 1 + Math.floor(r() * 40) : 0;
  const ragged = r() < 0.15 ? 1 + Math.floor(r() * 3) : 0;
  cases.push(makeCase(`synthetic #${k} (γ${g}${shortBy ? `, buffer ${shortBy} LEDs short` : ''}${ragged ? `, ${ragged} ragged bytes` : ''})`, fixtures, controllers, def, g, rawFor(fixtures, 1000 + k, shortBy, ragged), profiles));
}

// Gamma sweep.
const gammas = [];
for (let g = 0.1; g <= 4.0001; g += 0.01) gammas.push(Math.round(g * 100) / 100);
gammas.push(0, -1, NaN);

// ── run both sides ─────────────────────────────────────────────────────────────────────────────────────
const inFile = path.join(WORK, 'batch.json'), outFile = path.join(WORK, 'out.json');
fs.writeFileSync(inFile, JSON.stringify({ cases: cases.map(toRust), gammas: gammas.map((g) => (Number.isFinite(g) ? g : 0)) }));
try { execFileSync(ENGINE, ['--pack-batch', inFile, outFile], { stdio: ['ignore', 'inherit', 'pipe'] }); }
catch (e) {
  // A crash (a panic reading past a buffer, say) is a parity failure too, not a harness error.
  const tail = String(e.stderr).trim().split(/\r?\n/).slice(-2).join(' ');
  console.log(`the engine failed on the batch: ${tail}`);
  console.log('PARITY FAILED');
  process.exit(1);
}
const rust = JSON.parse(fs.readFileSync(outFile, 'utf8'));

let fails = 0;
let bytes = 0;
const tsThrew = [];
for (let i = 0; i < cases.length; i++) {
  // A case the TypeScript packer itself THROWS on (invalid input, e.g. a numeric colorOrder from a stale
  // generator) has no bytes to match: reported, excluded.
  let want;
  try { want = runTs(cases[i]); } catch (e) { tsThrew.push(`${cases[i].name}: ${e.message}`); continue; }
  const got = canon(rust.cases[i].destinations.map((d) => ({ ...d, universes: d.universes })));
  for (const d of want) for (const [, arr] of d.universes) bytes += arr.length;
  const a = JSON.stringify(want), b = JSON.stringify(got);
  if (a !== b) {
    fails++;
    if (fails <= 5) {
      let at = 0; while (at < a.length && a[at] === b[at]) at++;
      console.log(`FAIL ${cases[i].name}\n   TS:   …${a.slice(Math.max(0, at - 80), at + 80)}\n   Rust: …${b.slice(Math.max(0, at - 80), at + 80)}`);
    }
  }
}
let lutFails = 0;
gammas.forEach((g, i) => {
  const want = Array.from(TS.buildGammaLut(Number.isFinite(g) ? g : 0));
  if (JSON.stringify(want) !== JSON.stringify(rust.luts[i])) { lutFails++; if (lutFails <= 5) console.log(`FAIL gamma LUT γ=${g}`); }
});
if (tsThrew.length) {
  const uniq = [...new Set(tsThrew.map((t) => t.replace(/ \[.*?\]/, '')))];
  console.log(`excluded — the TypeScript packer throws on ${tsThrew.length} case(s) (invalid input):\n   ${uniq.join('\n   ')}`);
}
console.log(`${projectCount} projects, ${cases.length - tsThrew.length} cases, ${bytes} DMX bytes compared: ${fails ? `${fails} DIFFER` : 'identical'}`);
console.log(`gamma LUT, ${gammas.length} gammas: ${lutFails ? `${lutFails} DIFFER` : 'identical'}`);
console.log(fails || lutFails ? 'PARITY FAILED' : 'PARITY OK');
process.exit(fails || lutFails ? 1 : 0);
