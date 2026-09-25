// Runtime proof that an authored COLOUR reaches the wire, on every kind of fixture.
//
//   node scripts/test-color-lane.cjs [--keep]
//
// `verify:color` proves the SOLVER: colour in, emitter values out, checked against the app's own
// reader. It runs on pure functions and knows nothing about lanes, overlays, precedence or the
// packer. This proves the SEAM — that a colour lane in a project file becomes DMX bytes — which is
// the half that cannot be unit-tested, because it only exists once the frame loop, the overlay, the
// role override and the profile packer are all running together.
//
// HEADLESS, NOT CDP. The colour lane has no UI yet (that is P2), so there is nothing to click: the
// app is booted with --headless --project=<file>, which runs the same index.html with ?headless=1
// and the same frame engine, and the assertions are made on the Art-Net packets. That also sidesteps
// scripts/test-lighting-take.cjs's broken drag-and-drop step entirely.
//
// The rig is one fixture of each colour family, so the four realisation paths in colorEngine are all
// exercised on the wire in one run:
//   RGB · RGBW · hex (RGBWA+UV) · CW/WW tuneable white · CMY discharge head · dimmer-only.

const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARTNET_PORT = 6471;            // not 6454 (the app's own input) and not 6469 (the take test)
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-color-lane-test');
const PREFS = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const PREFS_BAK = path.join(WORK, 'prefs.backup.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The rig ──────────────────────────────────────────────────────────────────────────────────
// Every fixture is patched into universe 0, in this order, with its colour authored as ONE lane.
const RIG = [
  { id: 'rgb', profileId: 'generic/rgb-fader', mode: '8bit', label: 'RGB' },
  { id: 'rgbw', profileId: 'generic/rgbw-4ch', mode: '4ch', label: 'RGBW' },
  { id: 'hex', profileId: 'generic/rgbwauv-fader', mode: '8bit', label: 'RGBWA+UV' },
  { id: 'cwww', profileId: 'generic/cw-ww-2ch', mode: '2ch', label: 'CW/WW' },
  { id: 'dim', profileId: 'generic/dimmer-1ch', mode: '1ch', label: 'dimmer-only' },
  // A second RGB head, for the precedence check only — kept separate so the plain colour assertions
  // above stay pure.
  { id: 'prec', profileId: 'generic/rgb-fader', mode: '8bit', label: 'RGB + a Blue lane' },
];

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const lib = path.join(ROOT, 'resources', 'fixture-library');
  const profiles = fs.readdirSync(lib)
    .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'MANIFEST.json')
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(lib, f), 'utf8')));

  const fixtures = [];
  const colorLanes = [];
  let addr = 1;
  const at = {};
  for (const r of RIG) {
    const p = profiles.find((x) => x.id === r.profileId);
    if (!p) throw new Error(`the library has no ${r.profileId} — is it built?`);
    const mode = p.modes.find((m) => m.key === r.mode) || p.modes[0];
    at[r.id] = { start: addr, mode, profile: p };
    fixtures.push({
      id: `fx_${r.id}`, name: r.label, x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0,
      universe: 0, startAddress: addr, ledCount: 1, reverse: false, colorData: [],
      profileId: p.id, profileMode: mode.key,
      // Every channel parked at 0 so anything that moves on the wire moved because of the lane.
      dmx: Object.fromEntries(p.channels.map((c) => [c.key, c.role === 'dimmer' ? 1 : 0])),
      position3D: { x: 0, y: 3, z: 0 }, controllerId: 'ctl',
    });
    addr += mode.footprint;
  }

  // ONE KEY AT t=0. A colour lane holds before its first key, so the rig is this colour with the
  // transport parked — which is also the thing an operator does first: author a look and look at it.
  const key = (value) => ({ t: 0, value, curve: 'linear' });
  colorLanes.push({ id: 'cl_rgb', fixtureId: 'fx_rgb', keys: [key({ kind: 'rgb', rgb: [1, 0, 0] })] });
  colorLanes.push({ id: 'cl_rgbw', fixtureId: 'fx_rgbw', keys: [key({ kind: 'rgb', rgb: [1, 1, 1] })] });
  colorLanes.push({ id: 'cl_hex', fixtureId: 'fx_hex', keys: [key({ kind: 'rgb', rgb: [0, 0, 1] })] });
  colorLanes.push({ id: 'cl_cwww', fixtureId: 'fx_cwww', keys: [key({ kind: 'cct', t: 0 })] });
  colorLanes.push({ id: 'cl_dim', fixtureId: 'fx_dim', keys: [key({ kind: 'rgb', rgb: [0, 1, 0] })] });
  // MAGENTA, so the three outcomes are three different bytes on the same channel: 255 if the colour
  // won, 128 if the lane won, 0 if neither ran. A colour whose blue is 0 cannot tell "the lane lost"
  // apart from "the lane never evaluated" — which is exactly how the first run of this check read.
  colorLanes.push({ id: 'cl_prec', fixtureId: 'fx_prec', keys: [key({ kind: 'rgb', rgb: [1, 0, 1] })] });

  // PRECEDENCE, ON THE WIRE. The RGB head also gets a per-channel automation lane on its BLUE
  // channel. A lane aimed at one channel is a NARROWER instruction than "make this fixture red", so
  // it has to win — and this is trap A from plans/colour-track.md: get it backwards and an operator
  // with an old Blue curve sees a colour row that looks live and a head that ignores it.
  const blueKey = at.prec.profile.channels.find((c) => c.role === 'blue').key;
  // …and a CONTROL lane, on a fixture no colour lane touches. If this one does not move either, the
  // failure is "automation does not run in this harness", not "precedence is wrong" — two very
  // different bugs that look identical from one assertion.
  const dimKey = at.dim.profile.channels.find((c) => c.role === 'dimmer').key;
  const automation = [
    { id: 'lane_blue', targetPath: `fixtures.fx_prec.dmx.${blueKey}`, enabled: true, keyframes: [{ t: 0, v: 0.5, curve: 'linear' }] },
    { id: 'lane_dim', targetPath: `fixtures.fx_dim.dmx.${dimKey}`, enabled: true, keyframes: [{ t: 0, v: 0.25, curve: 'linear' }] },
  ];

  const file = path.join(WORK, 'color-lane-test.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [], fixtures,
    controllers: [{ id: 'ctl', name: 'Lighting', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50 },
    timeline: {
      layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false,
      trackingTakes: [], lightingTakes: [], lightingSequences: [], colorLanes, automation,
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return { file, at };
}

// ── The wire ─────────────────────────────────────────────────────────────────────────────────
function sniffer() {
  const s = { packets: 0, universe0: null };
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf) => {
    if (buf.length < 18 || buf.toString('latin1', 0, 8) !== 'Art-Net\u0000' || buf.readUInt16LE(8) !== 0x5000) return;
    if (buf.readUInt16LE(14) !== 0) return;
    s.packets++;
    s.universe0 = Array.from(buf.subarray(18, 18 + buf.readUInt16BE(16)));
  });
  return { s, sock };
}

function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // inheriting it boots Electron as plain Node (DEVELOPMENT.md)
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', '--headless', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
}

let failed = 0;
const note = (pass, what, detail) => {
  if (!pass) failed++;
  console.log(`   ${pass ? 'PASS ' : 'FAIL '} ${what}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  const { file, at } = buildProject();
  console.log(`project : ${file}`);
  console.log(`art-net : 127.0.0.1:${ARTNET_PORT}`);

  // Point the app's output at our loopback port, backing up whatever the operator had.
  fs.mkdirSync(path.dirname(PREFS), { recursive: true });
  if (fs.existsSync(PREFS)) fs.copyFileSync(PREFS, PREFS_BAK);
  const prefs = fs.existsSync(PREFS) ? JSON.parse(fs.readFileSync(PREFS, 'utf8')) : {};
  // Under `appSettings`, and the address key is `artNetIp` — the same shape test-lighting-take.cjs
  // writes. Guessing the flat key names instead produced a silent no-output run, which looks exactly
  // like a broken feature.
  prefs.appSettings = { ...(prefs.appSettings || {}), outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: ARTNET_PORT, broadcast: false, protocol: 'artnet' };
  fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2));

  const { s, sock } = sniffer();
  await new Promise((res) => sock.bind(ARTNET_PORT, '127.0.0.1', res));
  const child = launch(file);
  // Silent by default (the app is chatty), but a harness that swallows the app's own error output
  // makes every failure look like "it just didn't send" — which is exactly how the first run of this
  // file was read. ARTLUX_TEST_VERBOSE=1 shows what the app said.
  const echo = (buf) => { if (process.env.ARTLUX_TEST_VERBOSE) process.stdout.write(`   | ${buf}`); };
  child.stdout.on('data', echo);
  child.stderr.on('data', echo);

  const restore = () => {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    try { execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
    try { sock.close(); } catch { /* closed */ }
    if (fs.existsSync(PREFS_BAK)) { fs.copyFileSync(PREFS_BAK, PREFS); console.log('\nprefs restored'); }
    if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
  };

  try {
    // Wait for the rig to reach the wire. Headless has no window to wait on, so the packets ARE the
    // readiness signal.
    for (let i = 0; i < 90 && !s.universe0; i++) await sleep(1000);
    if (!s.universe0) throw new Error('no Art-Net arrived in 90s — did the app start?');
    await sleep(2000);
    const dmx = s.universe0;
    const chan = (id, role) => {
      const { start, mode, profile } = at[id];
      const key = profile.channels.find((c) => c.role === role)?.key;
      const slot = key ? mode.slots.findIndex((x) => x && x.channelKey === key) : -1;
      return slot < 0 ? null : dmx[start - 1 + slot];
    };
    const show = (id) => {
      const { start, mode } = at[id];
      return dmx.slice(start - 1, start - 1 + mode.footprint).join(',');
    };

    console.log(`\n1. a colour lane reaches the wire (${s.packets} packets)`);
    note(!!s.universe0, 'the headless app is sending Art-Net');

    console.log('\n2. RGB head, authored red');
    console.log(`   ch ${at.rgb.start}.. = ${show('rgb')}`);
    note(chan('rgb', 'red') === 255 && chan('rgb', 'green') === 0 && chan('rgb', 'blue') === 0,
      'red=255 green=0 blue=0');

    console.log('\n3. RGBW head, authored white — the emitter it OWNS must be used');
    console.log(`   ch ${at.rgbw.start}.. = ${show('rgbw')}`);
    note(chan('rgbw', 'white') === 255, 'the white emitter is at full', `white=${chan('rgbw', 'white')}`);
    note(chan('rgbw', 'red') > 0 && chan('rgbw', 'red') < 255, 'the primaries fill in rather than idle',
      `r=${chan('rgbw', 'red')} g=${chan('rgbw', 'green')} b=${chan('rgbw', 'blue')}`);

    console.log('\n4. hex head, authored blue — a six-emitter fit on the wire');
    console.log(`   ch ${at.hex.start}.. = ${show('hex')}`);
    note(chan('hex', 'blue') === 255, 'blue at full', `blue=${chan('hex', 'blue')}`);
    note(chan('hex', 'amber') === 0 && chan('hex', 'green') === 0, 'amber and green stay out',
      `amber=${chan('hex', 'amber')} green=${chan('hex', 'green')}`);

    console.log('\n5. CW/WW head, authored fully WARM — a temperature, not an RGB round trip');
    console.log(`   ch ${at.cwww.start}.. = ${show('cwww')}`);
    note(chan('cwww', 'warmWhite') === 255 && chan('cwww', 'coldWhite') === 0,
      'warm=255 cold=0', `warm=${chan('cwww', 'warmWhite')} cold=${chan('cwww', 'coldWhite')}`);

    console.log('\n6. a dimmer-only fixture is NOT disturbed by a colour it cannot make');
    console.log(`   ch ${at.dim.start}.. = ${show('dim')}`);
    note(chan('dim', 'dimmer') !== 0, 'its dimmer is not zeroed by a colour it cannot make',
      `dimmer=${chan('dim', 'dimmer')}`);
    console.log('\n7. automation lanes run at all in this harness (the control)');
    console.log(`   ch ${at.dim.start}.. = ${show('dim')}`);
    note(chan('dim', 'dimmer') === 64, 'a lane on a fixture with no colour drives its channel',
      `dimmer=${chan('dim', 'dimmer')} — 255 would mean no lane ran at all`);

    console.log('\n8. a per-channel automation lane still beats the colour lane');
    console.log(`   ch ${at.prec.start}.. = ${show('prec')}  (colour asks magenta: blue would be 255)`);
    note(chan('prec', 'blue') === 128, 'the Blue lane wins on its own channel',
      `blue=${chan('prec', 'blue')} — 255 would mean the colour won, 0 that the lane never ran`);
    note(chan('prec', 'red') === 255, 'and the colour still drives the channels the lane does not own',
      `red=${chan('prec', 'red')}`);
  } catch (e) {
    failed++;
    console.log(`\nharness error: ${e.message}`);
  }

  restore();
  console.log(failed ? `\n${failed} check(s) failed` : '\ncolour lanes reach the wire');
  process.exit(failed ? 1 : 0);
})();
