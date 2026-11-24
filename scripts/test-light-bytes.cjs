#!/usr/bin/env node
// E3f — EVERY LIGHT'S DMX SOLVED BY THE ENGINE, checked byte for byte on a PLAYING show (plans/native-engine.md §4).
//
//   node scripts/test-light-bytes.cjs --packaged <ArtLux.exe>
//
// The engine packs every light through its profile (lightpack.rs) from the document's fixture and this frame's
// layers — the light show as the ENGINE evaluates it (light.rs) — and CHECKS the bytes against what the app's
// packer wrote (`light bytes: differs`). The show is test:light-show-parity's (examples/lighting/02-a-recorded-busk
// with a sine, a pose sequence, a strobe and colour lanes: a colour WHEEL on the MAC 250 Beams, an RGBW mix on the
// Rogue washes) plus, added: a CMY spot (ayrton/diablo-s — no red emitter, so a clip driving `red` reaches it
// through the RGB→CMY bridge), a tuneable-white key light (aputure ls-600x-pro — a colour lane solved as a
// TEMPERATURE), and an automation lane on wash 1's dimmer (a lane-owned channel: the clip must not speak there).
// Gate: zero differing ticks, hundreds solved, all eight lights. Headless, SCRATCH profile, own processes only.
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-light-bytes.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const WORK = path.join(os.tmpdir(), 'artlux-light-bytes');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'lighting', '02-a-recorded-busk.artlux'), 'utf8'));
const tl = p.timeline;
p.lightingPoses = [{ id: 'pose_fan', name: 'Fan', slots: [{ pan: 0.3, tilt: 0.6, dimmer: 0.8 }, { pan: 0.7, tilt: 0.4, dimmer: 0.5 }] }];
p.colorPalette = [{ id: 'col_amber', name: 'Amber', value: { kind: 'rgb', rgb: [1, 0.55, 0.1] } }];
tl.lightingSequences = [...(tl.lightingSequences ?? []), {
  version: 1, id: 'seq_looks', name: 'Looks', duration: 6,
  keys: [
    { t: 0, slots: [{ pan: 0.2, dimmer: 0.2, zoom: 0.1 }, { pan: 0.8, dimmer: 0.4, zoom: 0.9 }], curve: 'easeInOutSine', roleCurves: { zoom: 'easeOutBounce' } },
    { t: 2, slots: [], poseRef: 'pose_fan', curve: 'bezier', cx1: 0.2, cy1: 0.8, cx2: 0.3, cy2: 1.1 },
    { t: 4, slots: [{ pan: 0.5, dimmer: 1, zoom: 0.5 }], curve: 'hold' },
  ],
}];
const lclip = (id, start, duration, lighting, inPoint = 0) => ({ id, layerId: 'lay_lighting', name: id, path: '', kind: 'lighting', start, duration, inPoint, lighting });
tl.clips.push(
  lclip('clip_wash_sine', 0, 12, { groupId: 'grp_washes', effect: { form: 'sine', role: 'dimmer', centre: 0.5, amplitude: 0.4, periodSec: 3 }, phase: 0.7, phaseMode: 'wing', wings: 1 }),
  lclip('clip_seq', 3, 8, { groupId: 'grp_movers', sequenceId: 'seq_looks', scale: 0.8, offset: 0.02, mirror: true, phase: 0.25, phaseMode: 'block', blocks: 2 }, 0.5),
  lclip('clip_strobe', 5, 4, { groupId: 'grp_movers', effect: { form: 'square', role: 'dimmer', centre: 0.5, amplitude: 0.5, periodSec: 0.8 }, phase: 0.1 }),
);
tl.colorLanes = [
  { id: 'cl_washes', groupId: 'grp_washes', phase: 0.5, phaseMode: 'block', blocks: 2, keys: [
    { t: 0, value: { kind: 'rgb', rgb: [1, 0, 0] }, curve: 'easeInOutCubic', space: 'oklab' },
    { t: 3, value: { kind: 'cct', t: 0.2 }, curve: 'linear' },
    { t: 6, value: { kind: 'cct', t: 0.9 }, curve: 'easeOutBack' },
    { t: 9, value: { kind: 'ref', id: 'col_amber' }, space: 'hsv' },
    { t: 11, value: { kind: 'rgb', rgb: [0, 0.3, 1] } },
  ] },
  { id: 'cl_m1', fixtureId: 'fx_mover_1', keys: [
    { t: 1, value: { kind: 'rgb', rgb: [0, 1, 0] }, space: 'hsv', curve: 'easeInQuad' },
    { t: 7, value: { kind: 'rgb', rgb: [1, 0, 1] } },
  ] },
];
// The two extra heads, patched after the washes on the same interface, and their group.
const base = p.fixtures.find((f) => f.id === 'fx_wash_2');
const head = (id, name, profileId, profileMode, startAddress, dmx) => ({ ...base, id, name, profileId, profileMode, startAddress, dmx, position3D: { x: startAddress / 40, y: 0, z: 3 } });
p.fixtures.push(head('fx_cmy', 'CMY spot', 'ayrton/diablo-s', 'std', 100, { dimmer: 1, cyan: 0.2 }), head('fx_cct', 'Key light', 'aputure/ls-600x-pro', 'p1', 140, { dimmer: 0.7, colorTemp: 0.3 }));
p.groups.push({ id: 'grp_extra', name: 'Extra', fixtureIds: ['fx_cmy', 'fx_cct'] });
tl.clips.push(lclip('clip_red', 0, 12, { groupId: 'grp_extra', effect: { form: 'sine', role: 'red', centre: 0.5, amplitude: 0.5, periodSec: 2 }, phase: 0.3 }));
tl.colorLanes.push({ id: 'cl_key', fixtureId: 'fx_cct', keys: [{ t: 0, value: { kind: 'cct', t: 0 }, curve: 'easeInOutSine' }, { t: 6, value: { kind: 'rgb', rgb: [0.4, 0.6, 1] } }, { t: 10, value: { kind: 'cct', t: 0.8 } }] });
tl.automation = [...(tl.automation ?? []), { id: 'auto_wash_dim', targetPath: 'fixtures.fx_wash_1.dmx.dimmer', keyframes: [{ t: 0, v: 0.1 }, { t: 6, v: 0.9, curve: 'easeInOutSine' }, { t: 12, v: 0.3 }] }];
p.stateMachine = { enabled: true, initialStateId: 'st', states: [{ id: 'st', name: 'Play', x: 100, y: 100, entry: [{ kind: 'play' }] }], transitions: [], regions: [] };
const project = path.join(WORK, 'light-bytes.artlux');
fs.writeFileSync(project, JSON.stringify(p, null, 2));

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: 6498, broadcast: false, protocol: 'artnet' } }));
  const logf = path.join(WORK, 'run-engine.log');
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, '--native-engine'], { env, stdio: ['ignore', log, log] });
  try { await sleep(34000); } finally { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } }
  const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/);
  let failed = 0;
  console.log(lines.filter((l) => /\[engine\].*(owns|keeps|light bytes|lighting: \d)/.test(l)).slice(0, 16).join(String.fromCharCode(10)));
  if (!lines.some((l) => /light bytes: every light's DMX is solved by the engine/.test(l))) { console.log("FAIL: the engine was not given the lights' profiles"); failed++; }
  const sums = lines.map((l) => l.match(/light bytes: (\d+) tick\(s\) solved \((\d+) light\(s\), (\d+) byte\(s\) this tick\), (\d+) tick\(s\) differing/)).filter(Boolean).map((m) => m.slice(1).map(Number));
  const last = sums[sums.length - 1] ?? [0, 0, 0, -1];
  const maxLights = Math.max(0, ...sums.map((s) => s[1])), maxBytes = Math.max(0, ...sums.map((s) => s[2]));
  console.log(`${last[0]}+ ticks solved; up to ${maxLights} lights and ${maxBytes} bytes a tick; ${last[3]} tick(s) differing`);
  for (const l of lines.filter((x) => /light bytes: differs|lighting: differs/.test(x)).slice(0, 6)) console.log(l);
  if (last[3] !== 0 || lines.some((l) => /light bytes: differs/.test(l))) { console.log("FAIL: the engine's light bytes disagree with the app's"); failed++; }
  if (lines.some((l) => /lighting: differs/.test(l))) { console.log("FAIL: the engine's light show disagrees with the app's"); failed++; }
  if (last[0] < 400) { console.log('FAIL: too few ticks solved'); failed++; }
  if (maxLights < 8) { console.log('FAIL: not every light was solved'); failed++; }
  console.log(failed ? `\nlight bytes: ${failed} FAILED` : '\nlight bytes OK');
  process.exit(failed ? 1 : 0);
})();
