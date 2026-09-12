// The show-control remote against the REAL app — the half no browser can answer.
//
//   node scripts/test-show-control.cjs [--keep]
//
// The page itself is covered by test-show-control-ui.cjs, which drives it in a browser against a
// protocol stub. This one launches ArtLux and asks the questions that need a live process:
//
//   1. a recursive scan finds projects on disk, and the list is served without being asked for;
//   2. a one-off (repeat:'once' + a date) survives the round trip through main and the scheduler
//      names it as next — the resolver used to work in minute-of-week, where a date cannot exist;
//   3. POST /shutdown answers BEFORE quitting, the process really exits, and the rig GOES DARK —
//      closing the app stops the stream but does not turn anything off, so a venue used to be left
//      lit at whatever was on screen (asserted off real ArtDmx packets, not off the source);
//   4. the exit is marked deliberate, so the Tier-2 supervisor tick stands down — while with the
//      marker removed the SAME tick still recovers, which is the half that matters: a marker that
//      is never lifted disarms unattended self-healing for good;
//   5. restart comes back.
//
// Nothing here can be answered by reading code: the frame is built in the renderer, packed by a Rust
// thread, and the supervisor is a PowerShell script that only exists on a venue machine.
//
// Windows-only (the Tier-2 half shells out to watchdog-check.ps1); the rest is portable.

const { spawn, spawnSync } = require('node:child_process');
const dgram = require('node:dgram');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const EXE = path.join(REPO, 'node_modules/electron/dist/electron.exe');
const APP_NAME = require(path.join(REPO, 'package.json')).name;         // userData is %APPDATA%/<name>
const USERDATA = path.join(process.env.APPDATA || '', APP_NAME);
const STOPPED = path.join(USERDATA, 'artlux-stopped.flag');
const TRIPPED = path.join(USERDATA, 'artlux-watchdog-tripped.flag');
const TMP = process.env.TEMP || process.env.TMPDIR || '.';
const PORT = 8788;
const ARTNET_PORT = 6454;

let fails = 0;
const ok = (n, c, x = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(EXE)) { console.error('electron is not installed — run npm install'); process.exit(1); }
if (!fs.existsSync(path.join(REPO, 'out/main/index.js'))) {
  console.error('out/ is missing — run `npm run build` first (this drives the BUILT renderer).');
  process.exit(1);
}

// ─── fixtures ───────────────────────────────────────────────────────────────────────────────────

// A venue-shaped tree: shows filed under subfolders, plus a portable project folder. The one-level
// scan this replaced found none of it.
function makeTree() {
  const root = path.join(TMP, 'artlux-showctl-shows');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'Museum', 'Hall A'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Museum', 'Hall B', 'Gala', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Lobby.artlux'), '{}');
  fs.writeFileSync(path.join(root, 'Museum', 'Hall A', 'hall-a.artlux'), '{}');
  fs.writeFileSync(path.join(root, 'Museum', 'Hall B', 'Gala', 'project.artlux'), '{}');
  return root;
}

// A project that can only be LIT: one surface filled with a solid effect at full, one 60-pixel strip
// sampling it, one Art-Net controller on loopback. The blackout assertion needs something guaranteed
// non-zero on the wire — a real show's output depends on its content and its transport state, which
// is not a thing to hang a test on (the first attempt used a real project and sat at zero all run).
function makeLitProject() {
  const base = JSON.parse(fs.readFileSync(path.join(REPO, 'examples/audio/01-the-bed.artlux'), 'utf-8'));
  const d = base.doc || base;
  d.surfaces = [{
    id: 'srf_lit', name: 'Lit wall', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0,
    content: { type: 'EFFECT', effectId: 0, paletteId: 0, speed: 0, intensity: 1, opacity: 1 },
  }];
  d.fixtures = [{
    id: 'fx_lit', name: 'Strip', x: 0.05, y: 0.45, width: 0.9, height: 0.1, rotation: 0,
    universe: 0, startAddress: 1, ledCount: 60, reverse: false, colorData: [],
    source: 'MEDIA', surfaceId: 'srf_lit', shape: 'LINE', colorOrder: 'RGB',
    rgbwMode: 'NONE', channelsPerPixel: 3,
  }];
  d.controllers = [{ id: 'ctl_local', name: 'Loopback', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0 }];
  d.globalBrightness = 1;
  // A state machine or a timeline waiting for a trigger is another way to be dark.
  d.stateMachine = { enabled: false, states: [], transitions: [], initialStateId: null };
  d.schedule = [];
  delete d.audio;
  const out = path.join(TMP, 'artlux-showctl-lit.artlux');
  fs.writeFileSync(out, JSON.stringify(base, null, 2), 'utf-8');
  return out;
}

// ─── plumbing ───────────────────────────────────────────────────────────────────────────────────
const req = (method, p, body, token) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: {
    ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
  } }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

const procCount = (name) => spawnSync('powershell', ['-NoProfile', '-Command',
  `(Get-Process -Name ${name} -ErrorAction SilentlyContinue | Measure-Object).Count`],
{ encoding: 'utf-8' }).stdout.trim();
const alive = () => procCount('electron') !== '0';
const killAll = () => spawnSync('taskkill', ['/IM', 'electron.exe', '/F'], { stdio: 'ignore' });

// shell:false, and torn down with taskkill /T. With a shell, kill() kills cmd.exe and leaves
// electron holding the single-instance lock — the NEXT run then dies on "another instance is
// already running", which looks like a flake and is not one.
function launch(project) {
  const args = ['.', '--built-renderer'];
  if (project) args.push('--project=' + project);
  // ELECTRON_RUN_AS_NODE is set in some dev shells and makes electron start as plain node, where
  // `electron.app` is undefined and main dies on its first getVersion().
  const child = spawn(EXE, args, { cwd: REPO, shell: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, log: () => out };
}
async function waitForPin(h, secs = 120) {
  for (let i = 0; i < secs; i++) {
    await wait(1000);
    const m = /\(pin (\d{4})\)/.exec(h.log());
    if (m) return m[1];
  }
  return null;
}

// ─── ArtDmx, so the rig can be asked what it actually received ─────────────────────────────────
function parseArtDmx(buf) {
  if (buf.length < 18) return null;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net' || buf[7] !== 0) return null;
  if (buf.readUInt16LE(8) !== 0x5000) return null;               // OpDmx
  const data = buf.subarray(18, 18 + buf.readUInt16BE(16));
  let max = 0, nonZero = 0;
  for (const b of data) { if (b > max) max = b; if (b) nonZero++; }
  return { universe: buf.readUInt16LE(14), max, nonZero };
}

(async () => {
  killAll();
  for (const f of [STOPPED, TRIPPED]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
  await wait(800);

  const TREE = makeTree();
  const LIT = makeLitProject();
  console.log('userData: ' + USERDATA);

  // The wire tap. A port clash is not a failure of the app, so it degrades to skipping the
  // blackout assertions rather than reporting a bug that is not there.
  const packets = [];
  let sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const listening = await new Promise((resolve) => {
    sock.once('error', () => resolve(false));
    sock.bind(ARTNET_PORT, '0.0.0.0', () => { try { sock.setBroadcast(true); } catch { /* */ } resolve(true); });
  });
  if (listening) sock.on('message', (m) => { const p = parseArtDmx(m); if (p) packets.push({ ...p, t: Date.now() }); });
  else { sock = null; console.log(`(port ${ARTNET_PORT} is busy — the blackout check will be skipped)`); }

  // ── 1. the app, on a project that puts light on the wire ─────────────────────────────────
  console.log('\n[the embedded server]');
  let h = launch(LIT);
  let pin = await waitForPin(h);
  if (!pin) { console.error('the server never bound\n' + h.log().slice(-2000)); killAll(); process.exit(1); }
  const token = (await req('POST', '/pair', { pin, name: 'test' })).body.token;
  ok('binds, prints a PIN, and pairs', !!token);
  ok('no stale shutdown marker (a start clears it)', !fs.existsSync(STOPPED));

  // ── 2. recursive discovery ───────────────────────────────────────────────────────────────
  console.log('\n[a recursive scan of a real tree]');
  const scan = await req('POST', '/scan', { folder: TREE }, token);
  const names = (scan.body.projects || []).map((p) => (p.rel ? p.rel + '/' : '') + p.name).sort();
  console.log('  found: ' + JSON.stringify(names));
  ok('returns a ScanResult, not a bare array', Array.isArray(scan.body.projects) && 'truncated' in scan.body);
  ok('a top-level file', names.includes('Lobby'));
  ok('one two levels down', names.includes('Museum/Hall A/hall-a'));
  ok('a portable project folder', names.includes('Museum/Hall B/Gala'));
  ok('not falsely marked truncated', scan.body.truncated === false);

  const list = await req('GET', '/projects?token=' + token, null, token);
  ok('GET /projects serves the cached scan', (list.body.projects || []).length === names.length);
  ok('and remembers the folder', list.body.root === TREE, String(list.body.root));

  // ── 3. a one-off, through main ───────────────────────────────────────────────────────────
  console.log('\n[a one-off survives the round trip, and is named as next]');
  const entry = {
    id: 'e2e1', enabled: true, projectPath: path.join(TREE, 'Museum', 'Hall B', 'Gala', 'project.artlux'),
    name: 'Gala', time: '20:30', days: [], repeat: 'once', date: '2099-01-02',
  };
  await req('POST', '/playlist', { playlist: { enabled: true, folder: TREE, entries: [entry] } }, token);
  const back = await req('GET', '/playlist?token=' + token, null, token);
  const e = back.body.playlist.entries[0];
  ok('persisted verbatim', !!e && e.repeat === 'once' && e.date === '2099-01-02' && e.time === '20:30', JSON.stringify(e));
  // A one-off's window is asymmetric on purpose: unbounded forward (or a show booked for next month
  // reports "next: none" the moment it is saved), fading backward (or it would pin the machine to
  // last year's gala forever).
  ok('the scheduler names it as next, 70-odd years out', back.body.status.nextPath === entry.projectPath,
    JSON.stringify(back.body.status));
  ok('with a human "when"', /2099-01-02 20:30/.test(back.body.status.nextAt || ''), String(back.body.status.nextAt));

  const legacy = { id: 'old', enabled: true, projectPath: path.join(TREE, 'Lobby.artlux'), time: '00:01', days: [] };
  await req('POST', '/playlist', { playlist: { enabled: true, folder: TREE, entries: [legacy] } }, token);
  const back2 = await req('GET', '/playlist?token=' + token, null, token);
  ok('an entry with no repeat/date still resolves (zero migration)',
    back2.body.status.nextPath === legacy.projectPath || back2.body.status.nextAt !== null,
    JSON.stringify(back2.body.status));

  // ── 4. the stream carries the project list unasked ───────────────────────────────────────
  console.log('\n[SSE]');
  const events = await new Promise((resolve) => {
    const got = [];
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/events?token=' + token }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        for (const line of buf.split('\n\n')) {
          const m = /^data: (.*)$/m.exec(line);
          if (m) { try { got.push(JSON.parse(m[1])); } catch { /* partial frame */ } }
        }
        if (got.some((g) => g.t === 'projects')) { r.destroy(); resolve(got); }
      });
    });
    setTimeout(() => { r.destroy(); resolve(got); }, 8000);
  });
  const types = [...new Set(events.map((x) => x.t))];
  console.log('  events on connect: ' + JSON.stringify(types));
  ok('a projects event arrives without being asked for', types.includes('projects'));
  ok('carrying the scan', (events.find((x) => x.t === 'projects')?.scan.projects || []).length === names.length);
  ok('and the playlist too', types.includes('playlist'));

  // ── 5. is the rig actually lit before we stop it? ────────────────────────────────────────
  let litUniverses = [];
  if (sock) {
    console.log('\n[the rig is lit]');
    let lit = null;
    for (let i = 0; i < 40 && !lit; i++) {
      await wait(1000);
      lit = packets.filter((p) => p.t > Date.now() - 1500).find((p) => p.max > 0) || null;
    }
    ok('non-zero ArtDmx is on the wire', !!lit, `${packets.length} packets seen, all zero`);
    if (lit) {
      litUniverses = [...new Set(packets.filter((p) => p.t > Date.now() - 2000).map((p) => p.universe))];
      console.log('  universes: ' + JSON.stringify(litUniverses) + ', brightest channel ' + lit.max);
    }
  }

  // ── 6. the remote stops it, and the room goes dark ───────────────────────────────────────
  console.log('\n[the remote stops the app]');
  const markT = Date.now();
  const r = await req('POST', '/shutdown', {}, token);
  ok('POST /shutdown answers 200 BEFORE quitting', r.status === 200 && r.body.ok === true, JSON.stringify(r));

  let gone = false;
  for (let i = 0; i < 30; i++) { await wait(500); if (!alive()) { gone = true; break; } }
  ok('the process actually exited', gone);
  await wait(500);
  if (sock) { try { sock.close(); } catch { /* */ } }

  if (sock && litUniverses.length) {
    ok('it kept sending right up to the exit', packets.some((p) => p.t >= markT));
    const lastPerUniverse = new Map();
    for (const p of packets) lastPerUniverse.set(p.universe, p);
    const stillLit = [...lastPerUniverse.values()].filter((p) => p.max > 0);
    console.log('  last value per universe: ' + JSON.stringify([...lastPerUniverse.entries()]
      .map(([u, p]) => ({ universe: u, max: p.max, nonZero: p.nonZero }))));
    // THE ASSERTION THIS FILE EXISTS FOR. Stopping the stream does not turn anything off — nodes
    // hold their last level — so without an explicit blackout the venue stays lit all night.
    ok('every universe ends at ZERO — the rig is dark', stillLit.length === 0,
      'still lit: ' + JSON.stringify(stillLit.map((p) => ({ universe: p.universe, max: p.max }))));
    ok('every universe that was lit got a final packet', litUniverses.every((u) => lastPerUniverse.has(u)));
  }

  ok('the exit left the deliberate-shutdown marker', fs.existsSync(STOPPED));
  ok('and did NOT trip the breaker (this was not a fault)', !fs.existsSync(TRIPPED));

  const lines = fs.readFileSync(path.join(USERDATA, 'artlux-watchdog.log'), 'utf-8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const last = lines[lines.length - 1];
  ok('the watchdog log records WHO stopped it', !!last && last.trigger === 'shutdown' && last.action === 'stopped',
    JSON.stringify(last));

  // ── 7. Tier-2 stands down for a shutdown, and still recovers a crash ─────────────────────
  //
  // THROUGH A STUB EXE, and without one this test is worthless: watchdog-check.ps1 derives BOTH the
  // process name it looks for AND the userData folder it reads the markers from out of the -Exe base
  // name. Point it at electron.exe and it checks %APPDATA%\electron for a flag the app writes to
  // %APPDATA%\artlux — it then "passes" by never seeing the marker at all, which is the opposite of
  // what it claims to prove. A stub named after the app lines both up with the real install.
  console.log('\n[the OS supervisor tick, run as the Scheduled Task runs it]');
  const stubDir = path.join(TMP, 'artlux-showctl-stub');
  fs.rmSync(stubDir, { recursive: true, force: true });
  fs.mkdirSync(stubDir, { recursive: true });
  const STUB = path.join(stubDir, APP_NAME + '.exe');
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'cmd.exe'), STUB);
  const stubAlive = () => procCount(APP_NAME) !== '0';
  const killStub = () => spawnSync('taskkill', ['/IM', APP_NAME + '.exe', '/F'], { stdio: 'ignore' });
  const tick = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(REPO, 'scripts/watchdog-check.ps1'), '-Exe', STUB, '-Project', ''], { encoding: 'utf-8' });

  killStub();
  ok('the stub reads the same userData the app writes to',
    path.join(process.env.APPDATA, APP_NAME) === USERDATA, USERDATA);
  tick();
  await wait(2500);
  ok('it refuses to resurrect a deliberately-stopped app', !stubAlive());

  fs.rmSync(STOPPED, { force: true });            // the state after a normal start
  tick();
  let backUp = false;
  for (let i = 0; i < 20; i++) { await wait(500); if (stubAlive()) { backUp = true; break; } }
  ok('with no marker, the SAME tick does bring it back (self-healing intact)', backUp);
  killStub();
  fs.rmSync(stubDir, { recursive: true, force: true });
  await wait(500);

  // ── 8. a start is what lifts the marker, and restart comes back ──────────────────────────
  console.log('\n[a person starting the app lifts the marker]');
  fs.writeFileSync(STOPPED, new Date().toISOString());
  h = launch(LIT);
  pin = await waitForPin(h);
  ok('the app starts normally with the marker present', !!pin);
  ok('and clears it on the way up', !fs.existsSync(STOPPED));

  console.log('\n[restart]');
  const tok2 = (await req('POST', '/pair', { pin, name: 'test' })).body.token;
  ok('POST /restart answers 200', (await req('POST', '/restart', {}, tok2)).status === 200);
  await wait(3000);
  let served = false;
  for (let i = 0; i < 45 && !served; i++) {
    await wait(1000);
    try { served = (await req('GET', '/health')).status === 200; } catch { /* not yet */ }
  }
  ok('the successor is serving again', served);
  ok('a restart leaves NO shutdown marker (it means to come back)', !fs.existsSync(STOPPED));

  killAll();
  for (const f of [STOPPED, TRIPPED]) { try { fs.rmSync(f, { force: true }); } catch { /* */ } }
  if (!KEEP) {
    fs.rmSync(TREE, { recursive: true, force: true });
    fs.rmSync(LIT, { force: true });
  } else {
    console.log('\nkept: ' + TREE + '\n      ' + LIT);
  }
  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); killAll(); process.exit(1); });
