#!/usr/bin/env node
// E1f-1 THE NATIVE ENGINE TAKES THE WIRE — in the REAL app (Windows).
//
//   node scripts/test-native-takeover.cjs [--packaged <ArtLux.exe>]
//
// Drives ArtLux headless on its own project, Art-Net to loopback, and watches the wire — WHO sends each
// packet (its UDP source port → the owning process, Get-NetUDPEndpoint), and WHAT it carries:
//   A. without --native-engine: the app (Electron) sends; its bytes are the reference;
//   B. with it: the ENGINE takes the wire — after the handover only artlux-engine sends, and the universes
//      carry the SAME bytes as the app's (stills chosen where the engine is byte-identical, E1d-1);
//   C. kill the engine: the app's frames reach the wire again at once (the fallback), the engine is
//      restarted by main's watchdog and takes the wire back;
//   D. the machine log says so (category `engine`: owns-wire / app-has-wire).
// The operator's prefs are backed up and restored, including after a failure.

const { spawn, execSync, execFileSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const PORT = 6483;
const PREFS = path.join(process.env.APPDATA, 'ArtLux', 'artlux-prefs.json');
const WORK = path.join(os.tmpdir(), 'artlux-native-takeover');
const PREFS_BAK = path.join(WORK, 'prefs.backup.json');
fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pk = process.argv.indexOf('--packaged');
const PACKAGED = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));

// ── the project: two stills the cells ENLARGE (no mip level involved). Heavily SHRUNK stills are where the
// engine is not byte-identical by design (E1d-1: identical, or more faithful to the picture) — measured here
// first with a 640×360 noise: 389 of 512 channels apart, while the engine's live wire equalled `--frame-once`
// of the same document exactly. Byte equality on the wire is asserted where E1d-1 asserts it.
function writePng(name, w, h, px) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y); png.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4); }
  const f = path.join(WORK, name); fs.writeFileSync(f, PNG.sync.write(png)); return f;
}
let seed = 9; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const noise = writePng('noise-40x22.png', 40, 22, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
const soft = writePng('soft-24x14.png', 24, 14, (x, y) => [Math.round(127 + 120 * Math.sin(x / 3)), Math.round(127 + 120 * Math.cos(y / 2)), (x * 10 + y * 7) % 256]);
const project = path.join(WORK, 'takeover.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sN', name: 'Noise', x: 0.02, y: 0.02, width: 0.46, height: 0.46, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: noise, opacity: 1 } },
    { id: 'sS', name: 'Soft', x: 0.52, y: 0.02, width: 0.46, height: 0.46, rotation: 0, zIndex: 1, content: { type: 'IMAGE', url: soft, opacity: 0.8 } },
  ],
  fixtures: [
    { id: 'fN', name: 'Noise strip', surfaceId: 'sN', x: 0.03, y: 0.2, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 0, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 },
    { id: 'fS', name: 'Soft matrix', surfaceId: 'sS', x: 0.54, y: 0.04, width: 0.42, height: 0.42, rotation: 0, ledCount: 160, universe: 1, startAddress: 1, colorOrder: 'GRB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true },
  ],
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));
// E1f "2a": a SPOUT surface, fed by a REAL Spout sender (artlux-engine --spout-send --image, Spout's own
// library) for the whole test — the app reads it through its Spout plugin, the engine through spout.rs SpoutIn.
const SPOUT_NAME = 'artlux-takeover-spout';
const spoutPic = writePng('spout-48x27.png', 48, 27, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 29) % 256, (x * y * 3) % 256]);
{
  const pj = JSON.parse(fs.readFileSync(project, 'utf8'));
  pj.surfaces.push({ id: 'sSp', name: 'Spout', x: 0.02, y: 0.52, width: 0.46, height: 0.26, rotation: 0, zIndex: 2, content: { type: 'SPOUT', spoutName: SPOUT_NAME, opacity: 1 } });
  pj.fixtures.push({ id: 'fSp', name: 'Spout strip', surfaceId: 'sSp', x: 0.03, y: 0.6, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 4, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
  fs.writeFileSync(project, JSON.stringify(pj, null, 2));
}
// Item 2b: an NDI surface, fed by a REAL NDI sender for the whole test — the app's own NDI addon
// (native/ndi ndi.node: sendCreate / sendFrame, Node-loadable) in a child process. The app receives it through
// its NDI plugin, the engine through ndi.rs.
const NDI_NAME = 'ArtLux takeover NDI';
const NDI_W = 64, NDI_H = 36;
{
  const pj = JSON.parse(fs.readFileSync(project, 'utf8'));
  pj.surfaces.push({ id: 'sNdi', name: 'NDI', x: 0.52, y: 0.52, width: 0.46, height: 0.26, rotation: 0, zIndex: 3, content: { type: 'NDI', ndiName: '', opacity: 1 } });
  pj.fixtures.push({ id: 'fNdi', name: 'NDI strip', surfaceId: 'sNdi', x: 0.53, y: 0.6, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 5, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
  fs.writeFileSync(project, JSON.stringify(pj, null, 2));
}
// Item 2c-4: an MP4 surface — a 2-second loop of 8 DISTINCT frames at 4 fps (engine/testdata, made by
// test:mp4-parity's encoder), played by the app's plugins/mp4 and decoded by the engine on the GPU (mf.rs).
// It MOVES, so the engine's bytes cannot be compared to one frame of the app's: run A collects every
// payload the app put on the wire across several loops, and every payload the engine sends must be one of
// them (within 1 — the GPU conversion is within 1 of Chromium, test:mp4-parity), and it must move too.
const MP4_CLIP = path.join(ROOT, 'engine', 'testdata', 'loop-avc-640x360.mp4');
{
  const pj = JSON.parse(fs.readFileSync(project, 'utf8'));
  pj.surfaces.push({ id: 'sMp4', name: 'MP4', x: 0.02, y: 0.8, width: 0.46, height: 0.18, rotation: 0, zIndex: 4, content: { type: 'VIDEO', url: MP4_CLIP, opacity: 1 } });
  pj.fixtures.push({ id: 'fMp4', name: 'MP4 strip', surfaceId: 'sMp4', x: 0.03, y: 0.89, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 6, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
  fs.writeFileSync(project, JSON.stringify(pj, null, 2));
}
// E1f-2: LIGHT fixtures beside the pixels — generic profiles from the app's own library, authored values
// in `dmx` (normalised), one SPILLING past channel 512. Their bytes are the app's precedence stack's; the
// engine only places them.
{
  const pj = JSON.parse(fs.readFileSync(project, 'utf8'));
  const head = (id, name, universe, startAddress, profileId, profileMode, dmx) => ({ id, name, x: 0.5, y: 0.8, width: 0.02, height: 0.02, rotation: 0,
    ledCount: 1, universe, startAddress, colorOrder: 'RGB', channelsPerPixel: 3, profileId, profileMode, dmx });
  pj.fixtures.push(
    head('L1', 'Wash 1', 2, 1, 'generic/rgbw-fader', '8bit', { red: 1, green: 0.5, blue: 0.25, white: 0.333 }),
    head('L2', 'Wash 2', 2, 510, 'generic/rgbw-fader', '8bit', { red: 0.2, green: 0.4, blue: 0.6, white: 0.8 }),
    head('L3', 'Dimmer', 3, 200, 'generic/dimmer-1ch', undefined, { dimmer: 0.75 }),
  );
  fs.writeFileSync(project, JSON.stringify(pj, null, 2));
}

// ── the wire, with WHO sent each packet ────────────────────────────────────────────────────────────────
// WHO SENT IT: every UDP endpoint's owning process, refreshed in the BACKGROUND (an async PowerShell
// poll). A synchronous lookup per new port blocked this script's event loop for ~1 s, which delayed the
// packets' timestamps — the first version reported a 1.5 s handback that was this script's, not the app's.
const portOwner = new Map();
const enginePids = new Set();   // seen by the poll — so the kill needs no synchronous lookup
let polling = true;
(async function pollOwners() {
  const { execFile } = require('node:child_process');
  while (polling) {
    await new Promise((res) => execFile('powershell', ['-NoProfile', '-Command',
      "Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p) { \"$($_.LocalPort) $($p.ProcessName) $($p.Id)\" } }"],
      { encoding: 'utf8', windowsHide: true }, (err, out) => {
        if (!err) for (const l of out.split(/\r?\n/)) { const m = /^(\d+) (\S+) (\d+)$/.exec(l.trim()); if (m) { portOwner.set(Number(m[1]), m[2]); if (/artlux-engine/i.test(m[2])) enginePids.add(Number(m[3])); } }
        res();
      }));
    await sleep(250);
  }
})();
function ownerOf(port) { return portOwner.get(port) ?? 'pending'; }
const packets = [];
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', (m, rinfo) => {
  if (m.length < 18 || m.toString('latin1', 0, 8) !== 'Art-Net\u0000' || m.readUInt16LE(8) !== 0x5000) return;
  packets.push({ at: Date.now(), port: rinfo.port, u: m.readUInt16LE(14), data: Buffer.from(m.subarray(18, 18 + m.readUInt16BE(16))) });
});
const who = (p) => { const n = ownerOf(p.port); return /artlux-engine/i.test(n) ? 'engine' : /electron|artlux/i.test(n) ? 'app' : n; };
// A packet whose port is not resolved yet waits for the next poll — the analysis reads WHO afterwards.
const settle = () => sleep(800);

function launch(native) {
  const env = { ...process.env, ARTLUX_ENGINE_DOC_DUMP: path.join(WORK, 'doc.json') }; delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--headless', `--project=${project}`, ...(native ? ['--native-engine'] : [])];
  const child = PACKAGED
    ? spawn(PACKAGED, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm.cmd', ['run', 'dev', '--', '--', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  child.log = '';
  child.lines = [];
  const take = (d) => { child.log += d; for (const l of String(d).split(/\n/)) if (l.trim()) child.lines.push({ at: Date.now(), l: l.trim() }); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  return child;
}
async function stop() {
  try { execSync('taskkill /IM electron.exe /F /T', { stdio: 'ignore' }); } catch { /* none */ }
  try { execSync('taskkill /IM ArtLux.exe /F /T', { stdio: 'ignore' }); } catch { /* none */ }
  try { execSync('taskkill /IM artlux-engine.exe /F /T', { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(2500);
}
const lastOf = (list, u) => { for (let i = list.length - 1; i >= 0; i--) if (list[i].u === u) return list[i].data; return null; };
async function waitUntil(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(100); } return false; }

(async () => {
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
  const hadPrefs = fs.existsSync(PREFS);
  if (hadPrefs) fs.copyFileSync(PREFS, PREFS_BAK);
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));
  // The sender runs from a COPY under another name: the clean-up between runs kills artlux-engine.exe by name.
  const SENDER_EXE = path.join(WORK, 'spout-sender.exe');
  fs.copyFileSync(path.join(ROOT, 'engine', 'target', 'release', 'artlux-engine.exe'), SENDER_EXE);
  // The NDI sender: a static picture, ~30 fps, through the app's own addon.
  const ndiScript = path.join(WORK, 'ndi-sender.cjs');
  fs.writeFileSync(ndiScript, `const a = require(${JSON.stringify(path.join(ROOT, 'native', 'ndi', 'ndi.node'))});
a.sendCreate('t', ${JSON.stringify(NDI_NAME)});
const w = ${NDI_W}, h = ${NDI_H}, px = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; px[i] = (x * 41 + y * 7) % 256; px[i + 1] = (x * 3 + y * 53) % 256; px[i + 2] = (x * y * 5) % 256; px[i + 3] = 255; }
setInterval(() => a.sendFrame('t', w, h, px), 33);`);
  // ndi.node links the NDI runtime: give the sender the PATH the app's NDI plugin builds (ndiManager), or it
  // cannot load at all — and say so, rather than fail section A for a reason that is not the app's.
  const BS = String.fromCharCode(92);
  const ndiDirs = [process.env.NDI_RUNTIME_DIR_V6, process.env.NDI_RUNTIME_DIR_V5, ['C:', 'Program Files', 'NDI', 'NDI 6 Runtime', 'v6'].join(BS),
    process.env.NDI_SDK_DIR ? path.join(process.env.NDI_SDK_DIR, 'Bin', 'x64') : null].filter((d) => d && fs.existsSync(d));
  const ndiSender = spawn(process.execPath, [ndiScript], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: [...ndiDirs, process.env.PATH].join(';') } });
  let ndiErr = ''; ndiSender.stderr.on('data', (d) => { ndiErr += d; });
  ndiSender.on('exit', (c) => { if (c) console.log(`NDI SENDER DIED (${c}): ${ndiErr.trim().slice(0, 300)}`); });
  const sender = spawn(SENDER_EXE, ['--spout-send', SPOUT_NAME, '--image', spoutPic, '--seconds', '600'], { stdio: 'ignore' });
  try {
    const prefs = hadPrefs ? JSON.parse(fs.readFileSync(PREFS, 'utf8')) : {};
    prefs.appSettings = { ...(prefs.appSettings || {}), outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet' };
    fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2));
    console.log(`project ${project} · Art-Net 127.0.0.1:${PORT} · ${PACKAGED ? `packaged ${PACKAGED}` : 'dev (npm run dev)'}`);

    // ── A. the app alone ───────────────────────────────────────────────────────────────────────────────
    let app = launch(false);
    ok(await waitUntil(() => packets.some((p) => p.u === 0) && packets.some((p) => p.u === 1), 120000), 'A. without the flag: the app puts both universes on the wire');
    // The live sources (Spout, NDI) arrive later than the stills — NDI discovery alone can take a retry.
    await waitUntil(() => [4, 5, 6].every((u) => packets.some((p) => p.u === u && p.data.some((b) => b > 0))), 30000);
    // Several loops of the MP4 clip, so every one of its frames is in run A's set.
    await sleep(6000);
    await settle();
    const A = packets.splice(0);
    const ref = { 0: lastOf(A, 0), 1: lastOf(A, 1), 2: lastOf(A, 2), 3: lastOf(A, 3), 4: lastOf(A, 4), 5: lastOf(A, 5) };
    ok(ref[5] && ref[5].some((b) => b > 0), `A. the NDI surface is on it (universe 5 lit: ${!!ref[5]?.some((b) => b > 0)})`);
    const appMp4 = [...new Map(A.filter((p) => p.u === 6).map((p) => [p.data.toString('hex'), p.data])).values()];
    ok(appMp4.length >= 4 && appMp4.some((d) => d.some((b) => b > 0)), `A. the MP4 surface is on it and MOVES (universe 6: ${appMp4.length} distinct payloads)`);
    ok(ref[4] && ref[4].some((b) => b > 0), `A. the Spout surface is on it (universe 4 lit: ${!!ref[4]?.some((b) => b > 0)})`);
    ok(ref[2] && ref[2][0] === 255 && ref[2][1] === 128 && ref[3] && ref[3].some((b) => b > 0), `A. the lights are on it too (wash 1 red ${ref[2]?.[0]}, green ${ref[2]?.[1]}; universe 3 lit: ${!!ref[3]?.some((b) => b > 0)})`);
    for (const u of [0, 1]) { const tailA = A.filter((p) => p.u === u).slice(-60); console.log(`     run A universe ${u}: ${new Set(tailA.map((p) => p.data.toString('hex'))).size} distinct payloads in its last ${tailA.length} packets`); }
    const sendersA = new Set(A.map(who));
    ok(sendersA.size === 1 && sendersA.has('app'), `A. sender: ${[...sendersA].join(', ')}`);
    ok(ref[0] && ref[0].some((b) => b > 0) && ref[1] && ref[1].some((b) => b > 0), 'A. the picture is on it (both universes lit)');
    await stop(); packets.length = 0;

    // ── B. with the native engine ────────────────────────────────────────────────────────────────────
    app = launch(true);
    const took = await waitUntil(() => packets.some((p) => who(p) === 'engine'), 120000);
    // ...and their frames reach the ENGINE too before the comparison (its own receivers connect afresh).
    await waitUntil(() => [4, 5, 6].every((u) => packets.some((p) => who(p) === 'engine' && p.u === u && p.data.some((b) => b > 0))), 30000);
    ok(took, 'B. with --native-engine: the ENGINE starts sending');
    // Long enough for TWO loops of the MP4 clip after the handover (2 s each): it must show all its frames.
    await sleep(5500); await settle();
    const handover = packets.findIndex((p) => who(p) === 'engine');
    // The app's own frames in THIS run, before the engine took over — the same launch, the same moment.
    const pre = packets.slice(0, handover).filter((p) => who(p) === 'app');
    for (const u of [0, 1]) {
      const a = lastOf(pre, u);
      if (a) fs.writeFileSync(path.join(WORK, `app-pre-u${u}.bin`), a);
      const cmp = (x, y) => { if (!x || !y) return 'n/a'; let nd = 0; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) nd++; return `${nd} differ`; };
      console.log(`     universe ${u}: app before the handover (${pre.filter((p) => p.u === u).length} pkts) vs run A: ${cmp(a, ref[u])}`);
    }
    const after = packets.slice(handover + 40);   // a frame or two in flight at the handover is not a double sender
    const sendersB = new Set(after.map(who));
    for (const u of [0, 1]) { const t = after.filter((p) => p.u === u).slice(-60); console.log(`     run B universe ${u}: ${new Set(t.map((p) => p.data.toString('hex'))).size} distinct payloads in the engine's last ${t.length} packets`); }
    ok(after.length > 50 && sendersB.size === 1 && sendersB.has('engine'), `B. after the handover only the engine sends (${after.length} packets: ${[...sendersB].join(', ')})`);
    for (const u of [0, 1, 2, 3, 4, 5]) {
      const got = lastOf(after, u);
      if (got) fs.writeFileSync(path.join(WORK, `engine-u${u}.bin`), got);
      if (ref[u]) fs.writeFileSync(path.join(WORK, `app-u${u}.bin`), ref[u]);
      if (got && ref[u]) { let nd = 0, mx = 0; for (let i = 0; i < got.length; i++) { const d = Math.abs(got[i] - ref[u][i]); if (d) nd++; mx = Math.max(mx, d); } console.log(`     universe ${u}: ${nd} of ${got.length} channels differ, max ${mx}`); }
      ok(got && ref[u] && Buffer.compare(got, ref[u]) === 0, `B. universe ${u}: the engine's bytes ${got && ref[u] && Buffer.compare(got, ref[u]) === 0 ? 'are IDENTICAL to the app\'s' : 'DIFFER from the app\'s'} (${got?.length} channels)`);
    }

    {
      // The MP4 surface: every payload the engine sent is one the app sent (within 1), and it moves.
      const eng = [...new Map(after.filter((p) => p.u === 6).map((p) => [p.data.toString('hex'), p.data])).values()];
      const dist = (x, y) => { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i])); return m; };
      const worst = eng.reduce((w, d) => Math.max(w, Math.min(...appMp4.map((a) => (a.length === d.length ? dist(a, d) : 255)))), 0);
      const exact = eng.filter((d) => appMp4.some((a) => Buffer.compare(a, d) === 0)).length;
      // ALL EIGHT frames of the clip: a decoder stuck past the first loop (the loop count not folded back into
      // the file) still moves for a while and then freezes — 6 of 8, measured.
      ok(eng.length >= 8 && worst <= 1, `B. universe 6 (MP4): ${eng.length} distinct engine payloads (the clip has 8 frames), each within ${worst} of one of the app's ${appMp4.length} (${exact} identical)`);
    }

    // ── C. the engine dies → the app has the wire again → the engine comes back and takes it ─────────────
    // RIGHT AFTER START-UP, on purpose. The audio engine used to open its device SYNCHRONOUSLY on main's JS
    // thread (~5.5 s on this rig's Realtek, WASAPI shared): main served nothing for those seconds — an
    // event-loop probe measured 7.4 s — and a kill inside that window was handed back only when main woke
    // (~2.5 s of a dark rig). The audio engine now runs on its own control thread (engine.cpp), so the
    // handback is held to the same bound here, at the worst moment, as at any other.
    packets.length = 0;
    // The PID first, then a NON-BLOCKING kill (TerminateProcess): a synchronous taskkill froze this script
    // while packets queued, and their late timestamps read as a slow handback.
    // ⚠ NOTHING SYNCHRONOUS DURING THE RUN. In dev, ArtLux's stdout is piped through npm to this script, and
    // on Windows a write to a full stdout pipe BLOCKS the writer: a synchronous PowerShell call here froze
    // ArtLux's MAIN process (an event-loop probe measured 7.4 s), and read as a slow handback.
    const enginePid = [...enginePids].pop();
    await sleep(500); packets.length = 0;
    const killedAt = Date.now();
    console.log(`     killedAt ${killedAt}`);
    try { process.kill(enginePid, 'SIGKILL'); } catch (e) { console.log(`     kill: ${e.message}`); }
    const back = await waitUntil(() => packets.some((p) => p.at > killedAt && who(p) === 'app'), 5000);
    const firstApp = packets.find((p) => p.at > killedAt && who(p) === 'app');
    ok(back && firstApp && firstApp.at - killedAt < 500, `C. engine killed (moments after start-up): the app's frames reach the wire again${firstApp ? ` ${firstApp.at - killedAt} ms after the kill` : ''}`);
    const retook = await waitUntil(() => packets.some((p) => p.at > (firstApp?.at ?? killedAt) && who(p) === 'engine'), 10000);
    ok(retook, 'C. the restarted engine takes the wire back');
    await sleep(2500);
    await settle();
    const tail = packets.slice(-60);
    ok(tail.length > 30 && tail.every((p) => who(p) === 'engine'), `C. ...and is again the only sender (${new Set(tail.map(who))})`);
    // The silence across the kill (no sender at all) — the gap an Art-Net node sees.
    let gap = 0; const around = packets.filter((p) => p.at >= killedAt - 1000);
    for (let i = 1; i < around.length; i++) gap = Math.max(gap, around[i].at - around[i - 1].at);
    const firstAfter = packets.find((p) => p.at > killedAt);
    gap = Math.max(gap, firstAfter ? firstAfter.at - killedAt : 0);
    console.log(`     longest silence on the wire across the kill and the restart: ${gap} ms`);
    for (const re of [/app keeps the wire: the engine exited/, /exited \(/, /\[engine\] up/, /owns the wire/]) {
      const hit = app.lines.find((x) => x.at > killedAt && re.test(x.l));
      console.log(`     main said "${re.source}" at ${hit ? hit.at - killedAt : '—'} ms`);
    }
    { // who sent what around the kill: runs of the same sender, with their ports
      const runs = []; for (const p of packets.filter((q) => q.at >= killedAt - 300 && q.at <= killedAt + 4000)) { const w = `${who(p)}:${p.port}`; const r = runs[runs.length - 1]; if (r && r.w === w) { r.n++; r.to = p.at - killedAt; } else runs.push({ w, n: 1, from: p.at - killedAt, to: p.at - killedAt }); }
      console.log('     around the kill: ' + runs.map((r) => `${r.w} ×${r.n} [${r.from}..${r.to} ms]`).join(' → '));
    }

    // ── D. what main said ────────────────────────────────────────────────────────────────────────────
    ok(/\[engine\] owns the wire \(document \d+\)/.test(app.log), 'D. main logged the engine owning the wire');
    ok(/\[engine\] the app keeps the wire: the engine exited/.test(app.log), 'D. ...and handing it back when the engine died');
    await stop();
    fs.writeFileSync(path.join(WORK, 'last-run.log'), app.log);
  } catch (e) {
    fails++; console.log(`FAIL ${e.stack || e}`);
    await stop();
  } finally {
    if (hadPrefs) fs.copyFileSync(PREFS_BAK, PREFS); else { try { fs.unlinkSync(PREFS); } catch { /* */ } }
    console.log('prefs restored');
    sock.close();
    polling = false;
    try { sender.kill(); } catch { /* gone */ }
    try { ndiSender.kill(); } catch { /* gone */ }
  }
  console.log(fails ? `\nNATIVE TAKEOVER FAILED: ${fails}` : '\nNATIVE TAKEOVER OK');
  process.exit(fails ? 1 : 0);
})();
