// Does an IMPORTED show actually run? Run: npm run test:import:runs
//
// The other two tests prove the import produces a document that is internally consistent
// (scripts/test-project-import.ts) and that its main-process halves behave
// (scripts/test-project-import-live.cjs). Neither proves the thing an operator actually cares about:
// that the show they just imported comes up and plays.
//
// That gap matters here more than it would anywhere else, because the failure mode is SILENT. The
// state machine tolerates a dangling reference everywhere by design — `enter()` does
// `if (s?.sceneId) ctx.recallScene(...)`, so a graph whose scenes did not survive the import enters
// its states on schedule, recalls nothing, and reports `playing: true` all night. Art-Net keeps
// flowing. Nothing throws, nothing logs, and the wire carries one unchanging frame forever.
//
// So this test does not ask "did it import". It asks: DOES THE LEVEL CHANGE ON THE WIRE, on its
// own, in the pattern the imported graph describes.
//
//   1. build a SOURCE project — 3 scenes holding one light at 3 dimmer levels, chained by a 1 s
//      afterDelay state machine that loops;
//   2. build a DESTINATION project that owns nothing but a controller pointed at loopback;
//   3. run the REAL import engine over them, in node, and write the merged project;
//   4. boot it `--headless` and watch Art-Net.
//
// A frozen level is the failure. Three recurring levels is the show.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARTNET_PORT = 6471;          // not 6454: the app's own Art-Net INPUT socket binds that
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-import-runs');
const SRC = path.join(WORK, 'source-show');
const DEST = path.join(WORK, 'dest-show');
const WATCH_MS = 12000;            // ~4 cycles of the 1 s × 3 ring
const BOOT_MS = 120000;            // a cold `npm run dev` builds before Electron even starts

// ⚠ WHETHER OUTPUT IS ON, AND WHERE IT GOES, ARE PREFS — NOT THE PROJECT. `AppSettings` is the
// machine, not the show (it was removed from ProjectData in P6), so a project cannot ask for its own
// output to be enabled and this test has to say so on the machine's behalf. The operator's real prefs
// are backed up first and restored in `finally`, including after a crash.
const PREFS = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const PREFS_BAK = path.join(WORK, 'prefs.backup.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const note = (ok, what, detail) => {
  if (!ok) failures++;
  console.log(`   ${ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}${detail ? `\n        ${detail}` : ''}`);
};

// The three dimmer levels the imported graph must produce, in order. Far enough apart that one
// cannot be mistaken for another, and none of them is 0 — a black frame is the DEFAULT, so a test
// that looked for it could not tell a working show from a dead one.
const LEVELS = [0.2, 0.55, 0.95];
const BYTE = LEVELS.map((v) => Math.round(v * 255));

// A one-channel fixture profile, embedded in the source project.
//
// ⚠ THE LOOK IS AUTHORED DMX, NOT SAMPLED PIXELS, and that is the whole reason this test can assert
// anything. An LED fixture takes its colour from a surface, which means a GPU, a decoded image and a
// composited frame — and scripts/test-engine-output.cjs already records that a dark reading in this
// environment "is legitimate and not a failure", so brightness sampled that way proves nothing. A
// light fixture's `dmx` values are authored and written straight into the universe by the packer, so
// what arrives on the wire is exactly what the scene stored. No GPU is involved.
const PROFILE = {
  id: 'test/lamp', manufacturer: 'Test', model: 'Lamp',
  channels: [{ key: 'dimmer', label: 'Dimmer', role: 'dimmer', resolution: 1, default: 0 }],
  modes: [{ key: 'std', name: 'Standard', footprint: 1, slots: [{ channelKey: 'dimmer', byte: 0 }] }],
  source: { origin: 'manual', importedAt: '2026-01-01T00:00:00.000Z' },
  verified: true,
};

function buildSource() {
  fs.mkdirSync(SRC, { recursive: true });

  // A light: profileId makes it one, and its ledCount is pinned to 1 on the update funnel.
  const fixture = (dimmer) => ({
    id: 'F_lamp', name: 'Lamp 1', x: 0.5, y: 0.5, width: 0.02, height: 0.02, rotation: 0,
    universe: 0, startAddress: 1, ledCount: 1, reverse: false, colorData: [],
    profileId: 'test/lamp', profileMode: 'std', dmx: { dimmer },
    position3D: { x: 0, y: 3, z: 0 },
  });
  const timeline = () => ({
    layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
    loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [],
    audio: { tracks: [], clips: [] }, boundedDuration: true,
  });

  // Three scenes, identical but for the level the lamp is authored at.
  const scenes = LEVELS.map((lvl, i) => ({
    id: `sc_${i}`, name: `Look ${i + 1}`,
    surfaces: [], fixtures: [fixture(lvl)],
    globalBrightness: 1,
    timeline: timeline(),
  }));

  // …chained into a ring. `afterDelay` needs no transport: the graph advances on its own, which is
  // what docs/STATE-MACHINE.md's own verification relies on ("with NO Play it should cycle").
  const states = scenes.map((sc, i) => ({
    id: `st_${i}`, name: sc.name, x: i * 200, y: 0, entry: [], sceneId: sc.id,
  }));
  const transitions = states.map((st, i) => ({
    id: `to_${i}`, from: st.id, to: states[(i + 1) % states.length].id,
    trigger: { kind: 'afterDelay', seconds: 1 },
  }));

  fs.writeFileSync(path.join(SRC, 'project.artlux'), JSON.stringify({
    version: '1.2', surfaces: [], fixtures: [fixture(LEVELS[0])], controllers: [],
    globalBrightness: 1, groups: [], scenes, cueBanks: [],
    stateMachine: { enabled: true, initialStateId: 'st_0', regions: [], states, transitions },
    timeline: timeline(), assets: [], projectorOutputs: [],
    fixtureProfiles: [PROFILE],
  }, null, 2));
}

function buildDest() {
  fs.mkdirSync(DEST, { recursive: true });
  const file = path.join(DEST, 'project.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', surfaces: [], fixtures: [],
    // THE DESTINATION OWNS THE CONTROLLER, and that is the point rather than a convenience:
    // controllers never travel with an import, so the fixtures that arrive have no controllerId and
    // are placed by auto-patch's `controllers[0]` fallback. If that rung ever broke, this test would
    // see silence on the wire rather than a wrong picture.
    controllers: [{
      id: 'ctl', name: 'Loopback', protocol: 'artnet', ip: '127.0.0.1',
      port: ARTNET_PORT, broadcast: false, startUniverse: 0,
    }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    stateMachine: { enabled: false, initialStateId: null, regions: [], states: [], transitions: [] },
    timeline: {
      layers: [], clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null,
      loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [],
      audio: { tracks: [], clips: [] }, boundedDuration: true,
    },
    assets: [], projectorOutputs: [],
  }, null, 2));
  return file;
}

/** Run the REAL engine — the same module the dialog calls — and write the merged project. */
function importSourceIntoDest(destFile) {
  const eng = require(path.join(ROOT, '.tmp-import', 'src', 'renderer', 'services', 'projectImport.js'));
  const abs = (root, p) => (path.isAbsolute(p) ? p : path.join(root, p));

  // What peekProject hands the renderer: parsed, with asset paths resolved to absolute.
  const src = JSON.parse(fs.readFileSync(path.join(SRC, 'project.artlux'), 'utf-8'));
  for (const s of [...(src.surfaces ?? []), ...(src.scenes ?? []).flatMap((sc) => sc.surfaces ?? [])]) {
    if (s.content?.url) s.content.url = abs(SRC, s.content.url);
  }
  const dest = JSON.parse(fs.readFileSync(destFile, 'utf-8'));

  const plan = eng.planImport(src, dest, { stateMachine: true }, {});
  const problems = eng.validateReferences({
    scenes: plan.patch.scenes,
    cueBanks: plan.patch.cueBanks,
    surfaces: plan.patch.surfaces,
    fixtures: plan.patch.fixtures,
    groups: plan.patch.groups,
    lightingPoses: plan.patch.lightingPoses,
    scene3D: { models: [], trackingZones: plan.patch.trackingZones },
    stateMachine: {
      enabled: true, initialStateId: plan.patch.initialStateId,
      states: plan.patch.states, transitions: plan.patch.transitions, regions: plan.patch.regions,
    },
  });

  // Commit exactly as App.handleImportProject does: append, and adopt the offered initial state only
  // because this destination has none of its own.
  const merged = {
    ...dest,
    surfaces: [...dest.surfaces, ...plan.patch.surfaces],
    fixtures: [...dest.fixtures, ...plan.patch.fixtures],
    groups: [...dest.groups, ...plan.patch.groups],
    scenes: [...dest.scenes, ...plan.patch.scenes],
    cueBanks: [...dest.cueBanks, ...plan.patch.cueBanks],
    // The carried profiles have to be WRITTEN here. App does this by calling
    // profiles.addEmbedded() — a runtime registry — and they only reach the file on the next save,
    // via profiles.usedBy(fixtures). This test writes the file itself, so it does that job too. A
    // fixture whose profile does not resolve has NO KNOWN FOOTPRINT and emits nothing at all, which
    // is exactly the silence this test first produced.
    fixtureProfiles: [...(dest.fixtureProfiles ?? []), ...plan.patch.fixtureProfiles],
    stateMachine: {
      enabled: true,
      initialStateId: dest.stateMachine.initialStateId ?? plan.patch.initialStateId,
      states: [...dest.stateMachine.states, ...plan.patch.states],
      transitions: [...dest.stateMachine.transitions, ...plan.patch.transitions],
      regions: [...dest.stateMachine.regions, ...plan.patch.regions],
    },
  };
  fs.writeFileSync(destFile, JSON.stringify(merged, null, 2));
  return { plan, problems, merged };
}

function sniffer() {
  // Peak byte per packet, in arrival order — enough to see the level change without decoding pixels.
  const s = { packets: 0, peaks: [] };
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf) => {
    // The Art-Net ID is 'Art-Net\0'. A trailing SPACE matches nothing — a documented trap.
    if (buf.length < 18 || buf.toString('latin1', 0, 8) !== 'Art-Net' + String.fromCharCode(0) || buf.readUInt16LE(8) !== 0x5000) return;
    const d = buf.subarray(18, 18 + Math.min(buf.readUInt16BE(16), 180));
    let max = 0;
    for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
    s.packets++;
    s.peaks.push(max);
  });
  return { s, sock };
}

function launch(projectFile) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // inheriting it boots Electron as plain Node (DEVELOPMENT.md)
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', '--headless', `--project=${projectFile}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}

async function stop(child) {
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  try { execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(2000);
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  buildSource();
  const destFile = buildDest();

  console.log('\n[1] the real engine merges the show');
  let merged;
  try {
    merged = importSourceIntoDest(destFile);
  } catch (e) {
    console.error('\x1b[31mERROR\x1b[0m', e.message);
    process.exit(1);
  }
  note(merged.plan.patch.scenes.length === 3, 'all three scenes were carried',
    `${merged.plan.patch.scenes.length} scenes`);
  note(merged.plan.patch.states.length === 3 && merged.plan.patch.transitions.length === 3,
    'the graph came across whole',
    `${merged.plan.patch.states.length} states, ${merged.plan.patch.transitions.length} transitions`);
  note(merged.problems.length === 0, 'the merged document has no dangling references',
    merged.problems.map((p) => `${p.where} -> ${p.missing}`).join('; '));
  note(merged.merged.fixtures.every((f) => f.controllerId === undefined),
    'imported fixtures carry no controller (auto-patch places them)');
  note(!!merged.merged.stateMachine.initialStateId,
    'the merged graph has an initial state, so it can actually start');

  console.log('\n[2] booting it --headless and watching Art-Net');
  const hadPrefs = fs.existsSync(PREFS);
  if (hadPrefs) fs.copyFileSync(PREFS, PREFS_BAK);
  const prefs = hadPrefs ? JSON.parse(fs.readFileSync(PREFS, 'utf8')) : {};
  fs.mkdirSync(path.dirname(PREFS), { recursive: true });
  fs.writeFileSync(PREFS, JSON.stringify({
    ...prefs,
    appSettings: {
      ...(prefs.appSettings || {}),
      outputEnabled: true, protocol: 'artnet',
      artNetIp: '127.0.0.1', artNetPort: ARTNET_PORT, broadcast: false,
    },
  }, null, 2));

  const { s, sock } = sniffer();
  await new Promise((res) => sock.bind(ARTNET_PORT, '127.0.0.1', res));
  const child = launch(destFile);
  try {
    // Wait for the app to actually come up before starting the clock — a cold dev run builds first,
    // and timing the boot as if it were the show is how this test would lie about a frozen level.
    const t0 = Date.now();
    while (s.packets === 0 && Date.now() - t0 < BOOT_MS) await sleep(500);
    note(s.packets > 0, 'ArtDmx reaches the wire at all',
      s.packets ? `first packet after ${((Date.now() - t0) / 1000).toFixed(1)}s` : `nothing in ${BOOT_MS / 1000}s`);
    if (!s.packets) throw new Error('no output — nothing further can be measured');

    // Only now does the observation window start.
    s.peaks.length = 0;
    await sleep(WATCH_MS);

    // THE ASSERTION THIS TEST EXISTS FOR. A graph whose scenes did not survive would still enter its
    // states, still output, and still look healthy — it would simply never change what it sends.
    const distinct = [...new Set(s.peaks)].sort((a, b) => a - b);
    const settled = distinct.filter((v) => s.peaks.filter((p) => p === v).length >= 3);
    note(settled.length >= 3,
      'the level CHANGES on its own, through at least three distinct values',
      `held 3+ frames: ${settled.join(', ') || 'none'} · expected about ${BYTE.join(', ')} — a frozen level means the graph recalls nothing`);

    // …and they are the RIGHT levels, not merely three of them. This is what separates "the graph
    // is cycling" from "the graph is cycling through looks that survived the import intact": each
    // byte is the dimmer value one specific imported scene authored.
    note(BYTE.every((b) => settled.includes(b)),
      'each imported scene recalls its OWN authored level',
      `wanted ${BYTE.join(', ')} · got ${settled.join(', ') || 'none'}`);

    // …and it is a RING, not a one-way trip: a level must be revisited.
    let revisits = 0;
    for (let i = 1; i < s.peaks.length; i++) {
      if (s.peaks[i] !== s.peaks[i - 1] && s.peaks.slice(0, i - 1).includes(s.peaks[i])) revisits++;
    }
    note(revisits > 0, 'and it LOOPS — a level is returned to', `${revisits} returns to an earlier level`);

    // The brightest scene recalls 1.0, the dimmest 0.25, so the spread must be wide. This is what
    // separates "the FSM is cycling" from "something else is dithering by a byte or two".
    const spread = distinct.length ? distinct[distinct.length - 1] - distinct[0] : 0;
    note(spread > 60, 'the levels are far apart, as the three scenes describe', `spread ${spread}/255`);
  } catch (e) {
    console.error(`\x1b[31mERROR\x1b[0m ${e.message}`);
  } finally {
    try { sock.close(); } catch { /* already closed */ }
    await stop(child);
    // THE OPERATOR'S OWN PREFS COME BACK, whatever happened above — this test turns their output on
    // and re-points Art-Net at loopback, and leaving either behind would silently take a real rig off
    // the wire the next time they open the app.
    if (hadPrefs && fs.existsSync(PREFS_BAK)) { fs.copyFileSync(PREFS_BAK, PREFS); console.log('   prefs restored'); }
    else if (!hadPrefs) { try { fs.rmSync(PREFS, { force: true }); } catch { /* never existed */ } }
    if (!KEEP) fs.rmSync(WORK, { recursive: true, force: true });
    else console.log(`\nkept: ${WORK}`);
  }

  console.log(failures === 0 ? '\n\x1b[32mALL PASS\x1b[0m' : `\n\x1b[31m${failures} FAILURE(S)\x1b[0m`);
  process.exit(failures === 0 ? 0 : 1);
})();
