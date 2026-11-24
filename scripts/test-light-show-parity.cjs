#!/usr/bin/env node
// E3e — THE LIGHT SHOW EVALUATED BY THE ENGINE, checked on a PLAYING show (plans/native-engine.md §4).
//
//   node scripts/test-light-show-parity.cjs --packaged <ArtLux.exe>
//
// The engine evaluates every active lighting clip's roles and every colour lane's colour at the playhead
// (light.rs) and CHECKS them against what the app's players published that frame (`lighting: differs`). The
// show is examples/lighting/02-a-recorded-busk (a recorded pan/tilt take, phase-spread over four movers) with,
// added: a generated sine on the washes' dimmer (wing spread), a pose sequence over the movers (inline slots, a
// named pose, roleCurves, scale, offset, mirror) overlapping the take — LTP pan, HTP dimmer against a square
// effect — and colour lanes (a group lane with block spread through rgb / cct / a palette colour, a fixture lane
// in hsv). It loops 12 s and plays itself for 24 s. Gate: zero differing ticks, hundreds evaluated, roles AND
// colours present. Headless, SCRATCH profile, own processes only.
'use strict';
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-light-show-parity.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const WORK = path.join(os.tmpdir(), 'artlux-light-show-parity');
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
p.stateMachine = { enabled: true, initialStateId: 'st', states: [{ id: 'st', name: 'Play', x: 100, y: 100, entry: [{ kind: 'play' }] }], transitions: [], regions: [] };
const project = path.join(WORK, 'light-show-parity.artlux');
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
  console.log(lines.filter((l) => /\[engine\].*(owns|keeps|lighting)/.test(l)).slice(0, 14).join('\n'));
  if (!lines.some((l) => /lighting: the light show is evaluated by the engine/.test(l))) { console.log('FAIL: the engine was not given the light show'); failed++; }
  const sums = lines.map((l) => l.match(/lighting: (\d+) tick\(s\) evaluated \((\d+) role value\(s\), (\d+) colour\(s\) this tick\), (\d+) tick\(s\) differing/)).filter(Boolean).map((m) => m.slice(1).map(Number));
  const last = sums[sums.length - 1] ?? [0, 0, 0, -1];
  const maxRoles = Math.max(0, ...sums.map((s) => s[1])), maxColors = Math.max(0, ...sums.map((s) => s[2]));
  console.log(`${last[0]}+ ticks evaluated; up to ${maxRoles} role values and ${maxColors} colours a tick; ${last[3]} tick(s) differing`);
  if (last[3] !== 0 || lines.some((l) => /lighting: differs/.test(l))) { console.log("FAIL: the engine's light show disagrees with the app's"); failed++; }
  if (last[0] < 400) { console.log('FAIL: too few ticks evaluated'); failed++; }
  if (maxRoles < 8 || maxColors < 2) { console.log('FAIL: the show did not drive roles and colours'); failed++; }
  console.log(failed ? `\nlight show parity: ${failed} FAILED` : '\nlight show parity OK');
  process.exit(failed ? 1 : 0);
})();
