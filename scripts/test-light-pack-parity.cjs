#!/usr/bin/env node
// E3f — A LIGHT'S DMX BYTES, TypeScript against Rust (plans/native-engine.md §4).
//
//   node scripts/test-light-pack-parity.cjs [--engine <artlux-engine.exe>]
//
// The app's own packer and colour solve — profilePack.ts packProfiled / modeOf, colorEngine.ts realiseColor,
// fixtureSignal.ts colorModel — are BUNDLED from source with esbuild (nothing copied) and run on one list of
// cases; the engine runs the same list (`--pack-cases`, lightpack.rs). The corpus is EVERY MODE of the shipped
// fixture library (resources/fixture-library), each packed several times with:
//   - authored values on random channels (and junk: strings, out-of-range, missing → the profile default);
//   - lighting-clip role values (pan / tilt in DEGREES, through the channel's physical range; dimmer; colour
//     roles — on a subtractive head the RGB→CMY bridge), a fired pose cue over them, a colour (rgb / cct) realised
//     through the head (mix / temperature / wheel / none), automation-owned channels, live faders;
// and every mixing / temperature / wheel mode realises a fixed set of colours on its own.
// The override is composed the way engine/frameEngine.ts packAndPublish composes it (live > owned lane > colour >
// cue > clip > CMY bridge > authored > default); the per-frame check on a playing show (test:light-bytes) holds
// frameEngine itself to the same answer. Gate: every byte identical, every realised role within 1e-12.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ek = process.argv.indexOf('--engine');
const ENGINE = ek > 0 ? path.resolve(process.argv[ek + 1]) : path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} — npm run build:engine`); process.exit(2); }

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'artlux-pack-parity-'));
const src = (f) => JSON.stringify(path.join(ROOT, 'src/renderer/services', f));
const entry = path.join(WORK, 'entry.ts');
fs.writeFileSync(entry, `
export { packProfiled, modeOf } from ${src('profilePack.ts')};
export { realiseColor } from ${src('colorEngine.ts')};
export { colorModel } from ${src('fixtureSignal.ts')};
`);
const bundle = path.join(WORK, 'pack.cjs');
require('esbuild').buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error', external: ['electron'] });
const ts = require(bundle);

const LIB = path.join(ROOT, 'resources', 'fixture-library');
const profiles = fs.readdirSync(LIB).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'MANIFEST.json')
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(LIB, f), 'utf8')));
if (profiles.length < 100) { console.error(`only ${profiles.length} profiles — is the library built?`); process.exit(1); }

let seed = 0x9ac4ed;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const COLOR_ROLES = ['red', 'green', 'blue', 'white', 'amber', 'uv', 'cyan', 'magenta', 'yellow', 'warmWhite', 'coldWhite'];
const COLORS = [
  { kind: 'rgb', rgb: [1, 0, 0] }, { kind: 'rgb', rgb: [0, 0.4, 1] }, { kind: 'rgb', rgb: [1, 0.65, 0.1] }, { kind: 'rgb', rgb: [1, 1, 1] },
  { kind: 'rgb', rgb: [0.35, 0, 0.7] }, { kind: 'rgb', rgb: [0, 0, 0] }, { kind: 'cct', t: 0 }, { kind: 'cct', t: 0.37 }, { kind: 'cct', t: 1 },
];
const randomColor = () => (rnd() < 0.6 ? pick(COLORS) : rnd() < 0.8 ? { kind: 'rgb', rgb: [rnd(), rnd(), rnd()] } : { kind: 'cct', t: rnd() * 1.2 - 0.1 });

// The role value a clip / cue would ask for a channel: degrees across (and past) a physical range, else 0..1-ish.
const roleValue = (c) => (c.min !== undefined && c.max !== undefined ? c.min + (c.max - c.min) * (rnd() * 1.2 - 0.1) : rnd() * 1.2 - 0.1);

// frameEngine.ts packAndPublish's roleOverride and liveOverride, composed over the case's inputs.
function tsPack(profile, fixture, o) {
  const mode = ts.modeOf(profile, fixture.profileMode);
  if (!mode) return null;
  const out = [];
  const realised = o.color ? ts.realiseColor(profile, mode, o.color) : undefined;
  const subtractive = ts.colorModel(profile, mode).subtractive;
  const CMY = { cyan: 'red', magenta: 'green', yellow: 'blue' };
  const get = (role) => o.cue?.[role] ?? o.roles?.[role];
  const override = (_id, channel) => {
    if (o.owned?.includes(channel.key)) return undefined;
    const fromColor = realised?.[channel.role];
    if (fromColor !== undefined) return fromColor;
    const direct = get(channel.role);
    if (direct !== undefined) return direct;
    const comp = CMY[channel.role];
    if (!comp || !subtractive) return undefined;
    const rgb = get(comp);
    return rgb === undefined ? undefined : 1 - rgb;
  };
  const live = o.live ? (_f, channel) => o.live[channel.key] : undefined;
  ts.packProfiled({ id: 'fx', ...fixture }, profile, mode, (v) => out.push(v), override, live);
  return out.map((v) => { const t = Math.trunc(Number(v)); return Number.isFinite(t) ? ((t % 256) + 256) % 256 : 0; });   // nativeLink's ToUint8
}

const cases = [], label = [], expect = [];
let modes = 0, realises = 0;
for (const profile of profiles) {
  for (const mode of profile.modes ?? []) {
    modes++;
    const inMode = new Set(mode.slots.filter(Boolean).map((s) => s.channelKey));
    const chans = profile.channels.filter((c) => inMode.has(c.key));
    for (let n = 0; n < 4; n++) {
      const fixture = { profileId: profile.id, profileMode: rnd() < 0.9 ? mode.key : pick([undefined, 'no-such-mode']) };
      const dmx = {};
      for (const c of chans) if (rnd() < 0.5) dmx[c.key] = rnd() < 0.9 ? rnd() * 1.2 - 0.1 : pick(['x', null, 2, -1]);
      fixture.dmx = dmx;
      const o = {};
      if (n > 0 && rnd() < 0.8) { o.roles = {}; for (const c of chans) if (rnd() < 0.6) o.roles[c.role] = roleValue(c); for (const r of COLOR_ROLES) if (rnd() < 0.2) o.roles[r] = rnd(); }
      if (n > 1 && rnd() < 0.5) { o.cue = {}; for (const c of chans) if (rnd() < 0.3) o.cue[c.role] = roleValue(c); if (rnd() < 0.3) o.cue.red = rnd(); }
      if (n > 0 && rnd() < 0.5) o.color = randomColor();
      if (rnd() < 0.25) o.owned = chans.filter(() => rnd() < 0.3).map((c) => c.key);
      if (rnd() < 0.2) { o.live = {}; for (const c of chans) if (rnd() < 0.2) o.live[c.key] = rnd() * 1.2 - 0.1; }
      cases.push({ pack: { profile, fixture, ...o } }); label.push(`${profile.id} / ${mode.key} #${n}`); expect.push(tsPack(profile, fixture, o));
    }
    for (const value of COLORS) {
      realises++;
      cases.push({ realise: { profile, mode: mode.key, value } }); label.push(`${profile.id} / ${mode.key} realise ${JSON.stringify(value)}`);
      // By KEY through modeOf, as a fixture names it: a profile can repeat a mode key (briteq bt-stagepar-6in1
      // has two '3ch'), and the first one is the one every fixture naming it gets.
      expect.push(ts.realiseColor(profile, ts.modeOf(profile, mode.key), value));
    }
  }
}

const inp = path.join(WORK, 'cases.json');
fs.writeFileSync(inp, JSON.stringify(cases));
const t0 = Date.now();
const got = JSON.parse(execFileSync(ENGINE, ['--pack-cases', inp], { maxBuffer: 1 << 30 }).toString());
console.log(`${cases.length} cases (${modes} modes of ${profiles.length} profiles, ${realises} colour realisations) in ${Date.now() - t0} ms`);

let failed = 0, worst = 0, bytes = 0;
const fail = (i, why) => { if (++failed <= 15) console.log(`FAIL ${label[i]}: ${why}`); };
for (let i = 0; i < cases.length; i++) {
  const e = expect[i], g = got[i];
  if (cases[i].pack) {
    if (e === null || g === null) { if (e !== g) fail(i, `ts ${JSON.stringify(e)}, engine ${JSON.stringify(g)}`); continue; }
    bytes += e.length;
    if (e.length !== g.length || e.some((v, j) => v !== g[j])) fail(i, `\n  ts     ${JSON.stringify(e)}\n  engine ${JSON.stringify(g)}`);
  } else {
    const ek = Object.keys(e).sort(), gk = Object.keys(g ?? {}).sort();
    if (ek.join() !== gk.join()) { fail(i, `roles ts ${ek}, engine ${gk}`); continue; }
    for (const k of ek) {
      const d = Math.abs(e[k] - g[k]);
      if (!(d <= 1e-12) && !(Number.isNaN(e[k]) && g[k] === null)) fail(i, `${k}: ts ${e[k]}, engine ${g[k]}`);
      else if (d > worst) worst = d;
    }
  }
}
console.log(`${bytes} bytes compared; worst realised-role difference ${worst.toExponential(2)}`);
console.log(failed ? `\nlight pack parity: ${failed} FAILED` : '\nlight pack parity OK');
fs.rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
