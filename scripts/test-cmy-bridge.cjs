// Runtime proof that the RGB→CMY colour bridge only fires on a head that is actually SUBTRACTIVE.
//
//   node scripts/test-cmy-bridge.cjs [--keep]
//
// A take and a pose key store colour as red/green/blue, because that is what the resolved fixture
// signal reads back whatever the head does internally. A discharge head has no channel with role
// `red`, so the packer bridges: cyan takes out red, magenta green, yellow blue. Without it, every
// recorded colour move landed on a CMY rig as silence — the clip looked right, the heads never moved.
//
// That bridge used to fire on ROLE ALONE. It therefore also fired on a mode emitting BOTH primaries
// and CMY — an RGBALC LED wash, where cyan is a real emitter and not a dichroic flag — so a clip
// driving `red` ALSO drove the cyan CHANNEL to 1-red, overwriting whatever the operator authored
// there. fixtureSignal reads those modes back as additive, so the read path and the write path
// disagreed about the same fixture. 17 modes in the shipped library are affected, among them the
// ETC Source Four LED Series 2/3 and fos/4 families.
//
// `npm run verify` reads source: it can assert the gate is spelled, never that the wire obeys it.
// This drives the real app and watches the bytes.
//
// The rig is one of each, patched into universe 0, driven by ONE lighting clip on `red`:
//   · cameo TS 200 FC / 6-channel Direct — red,green,blue,amber,lime,CYAN. Additive. ch1=red ch6=cyan
//   · Martin MAC 250 Beam / 16bt         — shutter,dimmer,C,M,Y,…        Subtractive.        ch9=cyan
// so one playback answers both halves: the additive head's cyan must HOLD while its red moves, and
// the subtractive head's cyan must still move INVERSELY to the same curve.

const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARTNET_PORT = 6469;           // not 6454: the app's own Art-Net INPUT socket binds that
const KEEP = process.argv.includes('--keep');
const PREFS = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const WORK = path.join(os.tmpdir(), 'artlux-cmy-bridge-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Where the watched channels sit on the wire (1-based DMX, universe 0) ─────────────────────────
const ADD_ADDR = 1;                 // cameo, footprint 6    → ch 1..6
const SUB_ADDR = 7;                 // MAC 250, footprint 13 → ch 7..19
const CH_ADD_RED = ADD_ADDR + 0;    // 1
const CH_ADD_CYAN = ADD_ADDR + 5;   // 6
const CH_SUB_CYAN = SUB_ADDR + 2;   // 9
const WATCH = [CH_ADD_RED, CH_ADD_CYAN, CH_SUB_CYAN];

// The authored cyan on the additive head. It must still be there at the end: that is the whole test.
const AUTHORED_CYAN = 0.25;

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const fixture = (id, name, profileId, profileMode, startAddress, dmx, x) => ({
    id, name, x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0,
    universe: 0, startAddress, ledCount: 1, reverse: false, colorData: [],
    profileId, profileMode, dmx, position3D: { x, y: 4, z: 0 }, controllerId: 'ctl_dmx',
  });

  // A curve on `red` ALONE. Nothing in this project mentions cyan, so every cyan byte on the wire is
  // the packer's own doing — which is exactly what is under test.
  const take = {
    version: 1, id: 'tk_red', name: 'Red ramp', duration: 4, fps: 30,
    parts: [{ channels: { red: [
      { t: 0, v: 0, curve: 'linear' },
      { t: 2, v: 1, curve: 'linear' },
      { t: 4, v: 0, curve: 'linear' },
    ] } }],
  };

  const file = path.join(WORK, 'cmy-bridge-test.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2',
    timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [],
    fixtures: [
      // Shutter and dimmer parked OPEN on the MAC, or its colour never reaches the wire at all.
      fixture('fx_add', 'Additive RGBALC', 'cameo/ts-200-fc', '6-channel-direct', ADD_ADDR,
        { red: 0, green: 0, blue: 0, amber: 0, lime: 0, cyan: AUTHORED_CYAN }, -2),
      fixture('fx_sub', 'Subtractive CMY', 'martin/mac-250-beam', '16bt', SUB_ADDR,
        {
          'shutter-strobe': 35 / 255, dimmer: 1, pan: 0.5, tilt: 0.5,
          'cyan-intensity': 0, 'magenta-intensity': 0, 'yellow-intensity': 0,
        }, 2),
    ],
    controllers: [{
      id: 'ctl_dmx', name: 'Lighting interface', protocol: 'artnet',
      ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light',
    }],
    globalBrightness: 1,
    groups: [{ id: 'grp_all', name: 'Both', fixtureIds: ['fx_add', 'fx_sub'] }],
    scenes: [], cueBanks: [],
    // START THE TRANSPORT WITH NO UI. The machine runs its initial state's entry actions on load, so
    // one `play` action replaces driving the shell over CDP — which is worth avoiding here for a
    // reason that cost a run: the transport lives in the TIMELINE DRAWER, the workspace layout is
    // banked per context, and this app can open into a saved workspace showing neither. A wire test
    // should not depend on which panels the operator last had on screen.
    stateMachine: {
      enabled: true,
      states: [{ id: 'st_run', name: 'Run', x: 0, y: 0, entry: [{ kind: 'play' }] }],
      transitions: [], initialStateId: 'st_run', regions: [],
    },
    scene3D: {
      models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true,
      reflectiveFloor: false, trackingViz: false, augmentaViz: false,
      trackingSmoothing: 0.6, trackingPredictMs: 50,
    },
    timeline: {
      layers: [{ id: 'lay_lighting', name: 'Lighting', kind: 'lighting', color: '#f5a623', enabled: true }],
      clips: [{
        id: 'clip_red', layerId: 'lay_lighting', name: 'Red ramp', path: '', kind: 'lighting',
        start: 0, duration: 12, inPoint: 0,
        lighting: { takeId: 'tk_red', groupId: 'grp_all', phase: 0 },
      }],
      duration: 20, fps: 30, markers: [], inPoint: null, outPoint: null, loop: true,
      trackingTakes: [], lightingTakes: [take], lightingSequences: [],
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

// A HISTORY of the watched channels, not a count: the question is what each byte did over time, and
// a packet counter answers something else.
function sniffer(watch) {
  const s = { packets: 0, hist: [], t0: Date.now() };
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf) => {
    if (buf.length < 18 || buf.toString('latin1', 0, 8) !== 'Art-Net\u0000' || buf.readUInt16LE(8) !== 0x5000) return;
    if (buf.readUInt16LE(14) !== 0) return;   // universe 0 only
    const d = buf.subarray(18, 18 + buf.readUInt16BE(16));
    s.packets++;
    s.hist.push([Date.now() - s.t0, ...watch.map((c) => d[c - 1])]);
    if (s.hist.length > 8000) s.hist.shift();
  });
  return { s, sock };
}

function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // inheriting it boots Electron as plain Node (DEVELOPMENT.md)
  const child = spawn(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function stop(child) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  try {
    execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' });
  } catch { /* none running */ }
  await sleep(2500);
}

let failures = 0;
const note = (ok, what, detail) => {
  if (!ok) failures++;
  console.log(`   ${ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}${detail ? `\n        ${detail}` : ''}`);
};

(async () => {
  const project = buildProject();

  // Point Art-Net at loopback on a port the app's own INPUT socket does not own, and put back
  // whatever the operator had when we are done.
  let prev = null;
  try { prev = fs.readFileSync(PREFS, 'utf8'); } catch { /* no prefs yet */ }
  const prefs = prev ? JSON.parse(prev) : {};
  prefs.appSettings = {
    ...(prefs.appSettings || {}),
    outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: ARTNET_PORT, broadcast: false,
  };
  fs.mkdirSync(path.dirname(PREFS), { recursive: true });
  fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2));

  const { s: wire, sock } = sniffer(WATCH);
  await new Promise((res) => sock.bind(ARTNET_PORT, res));

  const child = launch(project);
  try {
    // Wait for the WIRE, not for the window. The app needs ~15 s to its first frame, and what this
    // test needs is output — so the readiness signal is Art-Net arriving, which is the same thing.
    console.log('\nwaiting for output…');
    let waited = 0;
    while (wire.packets < 30 && waited < 90) { await sleep(1000); waited++; }
    if (wire.packets < 30) throw new Error(`no Art-Net after ${waited}s (packets ${wire.packets})`);
    console.log(`   output up after ~${waited}s\n`);

    // The state machine already pressed play. Let the ramp run through more than one cycle of the
    // 4 s take so the assertions see a whole shape, not a corner of one.
    console.log('one clip is driving ONLY the red role\n');
    const before = wire.hist.length;
    await sleep(9000);

    const run = wire.hist.slice(before);
    if (!run.length) throw new Error(`no Art-Net captured (total packets ${wire.packets})`);
    const col = (i) => run.map((r) => r[i + 1]);
    const distinct = (i) => new Set(col(i)).size;
    const red = col(0), addCyan = col(1);

    console.log(`   captured ${run.length} frames on universe 0\n`);

    // 1. The clip really is driving red on the additive head — without this the rest proves nothing,
    //    because a cyan that never moves is also what a dead clip looks like.
    note(distinct(0) > 20, 'the clip drives red on the additive head',
      `distinct red values ${distinct(0)} over ${Math.min(...red)}..${Math.max(...red)}`);

    // 2. THE FIX. Its cyan is an EMITTER, so the bridge must leave it alone: it must sit exactly
    //    where the project authored it, in every single frame.
    const want = Math.round(AUTHORED_CYAN * 255);
    note(addCyan.every((v) => v === want), 'the additive head\'s cyan HOLDS its authored value while red moves',
      `authored ${want}, seen ${[...new Set(addCyan)].sort((a, b) => a - b).join(',')} — before the fix this tracked 255-red`);

    // 3. …and the legitimate bridge is untouched. Compared frame by frame against red, not merely
    //    "it moved": moving is what the bug did too.
    const inverse = run.every((r) => Math.abs((255 - r[1]) - r[3]) <= 2);
    note(distinct(2) > 20 && inverse, 'the subtractive head\'s cyan still tracks 255-red',
      `distinct cyan values ${distinct(2)}; frame-by-frame |(255-red)-cyan| <= 2: ${inverse}`);
  } catch (e) {
    failures++;
    console.error('\n   \x1b[31mERROR\x1b[0m', e.message);
  } finally {
    await stop(child);
    sock.close();
    if (prev !== null) fs.writeFileSync(PREFS, prev); else { try { fs.unlinkSync(PREFS); } catch { /* none */ } }
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }

  console.log(failures
    ? `\n\x1b[31mCMY bridge: ${failures} failure(s)\x1b[0m`
    : '\n\x1b[32mCMY bridge OK — it fires on a subtractive head and leaves an emitter alone\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
