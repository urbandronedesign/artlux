#!/usr/bin/env node
// E6h — AN ENGINE DEATH DOES NOT DARKEN THE WIRE, even with no browser engine to fall back to (Windows).
//
//   node scripts/test-engine-hold.cjs [--packaged <ArtLux.exe>]
//
// Drives ArtLux headless with the native engine and ARTLUX_NO_APP_WIRE=1 — the app's own frames never reach the
// wire, as when the browser engine is gone (E6i) — Art-Net to loopback, and watches WHO sends each packet (its UDP
// source port → the owning process) and WHAT it carries. Then kills the engine:
//   1. main puts the engine's LAST FRAME on the wire at once (engine hold.rs → engineHost holdWire →
//      outputManager.hold), and its keep-alive repeats it — the longest silence on the wire across the death and
//      the restart stays short;
//   2. what main holds IS the engine's last frame, byte for byte, on every universe (a still, a strip of a still,
//      and a MOVING video strip — the frame it was showing when it died);
//   3. the restarted engine takes the wire back, and main LETS GO (releaseHold): after it, only the engine sends;
//   4. main says so ([engine] holding its last frame on the wire).
// Then the same for a RENDER-THREAD STALL (the engine's ARTLUX_ENGINE_TEST_STALL_FILE hook: its render thread stops
// while its stdin thread still answers pings — only main's "ticks in, no frame out" watch can see it): main holds,
// kills, restarts, lets go — and the engine's own keep-alive covered the stall itself, so the wire never went dark.
// Own scratch profile, own process tree only (never by name — the owner's session may be open beside it).

const { spawn, execSync, execFile } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const PORT = 6487;
const WORK = path.join(os.tmpdir(), 'artlux-engine-hold');
const PROFILE = path.join(WORK, 'profile');
fs.mkdirSync(WORK, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pk = process.argv.indexOf('--packaged');
const PACKAGED = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));

function writePng(name, w, h, px) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y); png.data.set([c[0], c[1], c[2], 255], (y * w + x) * 4); }
  const f = path.join(WORK, name); fs.writeFileSync(f, PNG.sync.write(png)); return f;
}
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const noise = writePng('noise-40x22.png', 40, 22, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
const MP4_CLIP = path.join(ROOT, 'engine', 'testdata', 'loop-avc-640x360.mp4');
const project = path.join(WORK, 'hold.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sN', name: 'Noise', x: 0.02, y: 0.02, width: 0.46, height: 0.46, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: noise, opacity: 1 } },
    { id: 'sV', name: 'Video', x: 0.52, y: 0.02, width: 0.46, height: 0.26, rotation: 0, zIndex: 1, content: { type: 'VIDEO', url: MP4_CLIP, opacity: 1 } },
  ],
  fixtures: [
    { id: 'f0', name: 'Noise strip', surfaceId: 'sN', x: 0.03, y: 0.2, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 0, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 },
    { id: 'f1', name: 'Noise strip 2', surfaceId: 'sN', x: 0.03, y: 0.3, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 1, startAddress: 1, colorOrder: 'GRB', channelsPerPixel: 3 },
    { id: 'f2', name: 'Video strip', surfaceId: 'sV', x: 0.53, y: 0.15, width: 0.44, height: 0.01, rotation: 0, ledCount: 150, universe: 2, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 },
  ],
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));
const UNIVERSES = [0, 1, 2];
const STALL_FILE = path.join(WORK, 'stall-now');
try { fs.unlinkSync(STALL_FILE); } catch { /* none */ }

// ── the wire, with WHO sent each packet (an async poll of the UDP endpoints' owning processes) ──────────
const portOwner = new Map();
const enginePids = new Set();
let polling = true;
(async function pollOwners() {
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
const packets = [];
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
sock.on('message', (m, rinfo) => {
  if (m.length < 18 || m.toString('latin1', 0, 8) !== 'Art-Net\u0000' || m.readUInt16LE(8) !== 0x5000) return;
  packets.push({ at: Date.now(), port: rinfo.port, u: m.readUInt16LE(14), data: Buffer.from(m.subarray(18, 18 + m.readUInt16BE(16))) });
});
const who = (p) => { const n = portOwner.get(p.port) ?? 'pending'; return /artlux-engine/i.test(n) ? 'engine' : /electron|artlux/i.test(n) ? 'app' : n; };
async function waitUntil(pred, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(50); } return false; }

let running = null;
function launch() {
  const env = { ...process.env, ARTLUX_NO_APP_WIRE: '1', ARTLUX_ENGINE_TEST_STALL_FILE: STALL_FILE }; delete env.ELECTRON_RUN_AS_NODE;
  const args = [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, '--native-engine'];
  const child = PACKAGED
    ? spawn(PACKAGED, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm.cmd', ['run', 'dev', '--', '--', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  child.lines = [];
  const take = (d) => { for (const l of String(d).split(/\n/)) if (l.trim()) child.lines.push({ at: Date.now(), l: l.trim() }); };
  child.stdout.on('data', take); child.stderr.on('data', take);
  running = child;
  return child;
}

(async () => {
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));
  try {
    fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet', keepAlive: true, fps: 44 } }, null, 2));
    console.log(`project ${project} · Art-Net 127.0.0.1:${PORT} · ${PACKAGED ? `packaged ${PACKAGED}` : 'dev'} · ARTLUX_NO_APP_WIRE=1`);
    const app = launch();
    ok(await waitUntil(() => UNIVERSES.every((u) => packets.some((p) => p.u === u && p.data.some((b) => b > 0))), 120000), 'the engine puts every universe on the wire');
    await sleep(5000);   // the video moving; the owner poll has resolved the engine's port
    const before = packets.slice(-400);
    ok(before.length > 50 && before.every((p) => who(p) === 'engine'), `before the kill only the engine sends (${[...new Set(before.map(who))].join(", ")}) — the app's own frames never reach the wire`);
    const vids = new Set(packets.filter((p) => p.u === 2).slice(-60).map((p) => p.data.toString('hex'))).size;
    ok(vids > 3, `the video strip MOVES (${vids} distinct payloads in its last 60 packets)`);

    // ── the death ───────────────────────────────────────────────────────────────────────────────────────
    const enginePid = [...enginePids].pop();
    packets.length = 0;
    await sleep(300);
    const killedAt = Date.now();
    // The engine's last payload per universe, as the wire saw it, up to the kill.
    const lastEngine = {};
    for (const p of packets) if (who(p) === 'engine') lastEngine[p.u] = p.data;
    try { process.kill(enginePid, 'SIGKILL'); } catch (e) { console.log(`     kill: ${e.message}`); }
    const held = await waitUntil(() => UNIVERSES.every((u) => packets.some((p) => p.at > killedAt && p.u === u && who(p) === 'app')), 3000);
    const firstHeld = packets.find((p) => p.at > killedAt && who(p) === 'app');
    ok(held && firstHeld && firstHeld.at - killedAt < 200, `1. main holds the wire at once (${firstHeld ? `${firstHeld.at - killedAt} ms after the kill` : 'nothing'})`);
    const retook = await waitUntil(() => packets.some((p) => p.at > (firstHeld?.at ?? killedAt) && who(p) === 'engine'), 15000);
    const engineBack = packets.find((p) => p.at > (firstHeld?.at ?? killedAt) && who(p) === 'engine');
    ok(retook, `3. the restarted engine takes the wire back (${engineBack ? `${engineBack.at - killedAt} ms after the kill` : 'never'})`);
    // What main held, per universe: every one of its packets the engine's last payload.
    const heldPk = packets.filter((p) => p.at > killedAt && who(p) === 'app');
    for (const u of UNIVERSES) {
      const mine = heldPk.filter((p) => p.u === u);
      const same = lastEngine[u] && mine.length > 0 && mine.every((p) => p.data.equals(lastEngine[u]));
      ok(same, `2. universe ${u}: main held the engine's LAST frame, byte for byte (${mine.length} packets${lastEngine[u] ? '' : ', no engine payload seen before the kill'})`);
    }
    await sleep(3000);
    const tail = packets.filter((p) => engineBack && p.at > engineBack.at + 300);
    ok(tail.length > 50 && tail.every((p) => who(p) === 'engine'), `3. ...and main LET GO: after the engine is back only it sends (${tail.length} packets: ${[...new Set(tail.map(who))].join(", ")})`);
    // The silence across the death and the restart — what a node sees.
    let gap = 0; const around = packets.filter((p) => p.at >= killedAt);
    gap = around.length ? around[0].at - killedAt : 99999;
    for (let i = 1; i < around.length; i++) gap = Math.max(gap, around[i].at - around[i - 1].at);
    ok(gap < 250, `the longest silence on the wire across the death and the restart: ${gap} ms`);
    const said = app.lines.find((x) => x.at > killedAt && /\[engine\] holding its last frame on the wire/.test(x.l));
    ok(!!said, `4. main said so (${said ? said.l : 'nothing'})`);

    // ── the stall ───────────────────────────────────────────────────────────────────────────────────────
    await sleep(2000);
    packets.length = 0;
    await sleep(300);
    const stalledAt = Date.now();
    fs.writeFileSync(STALL_FILE, '1');
    const noticed = await waitUntil(() => app.lines.some((x) => x.at > stalledAt && /\[engine\] the render thread stalled/.test(x.l)), 10000);
    const n = app.lines.find((x) => x.at > stalledAt && /\[engine\] the render thread stalled/.test(x.l));
    ok(noticed, `S1. main sees the stalled render thread (${n ? `${n.at - stalledAt} ms after the stall: ${n.l}` : 'never'})`);
    const killAt = n ? n.at : Date.now();
    // The engine's last payload per universe before main took over (its keep-alive repeated it through the stall).
    const lastE = {};
    for (const q of packets) if (q.at <= killAt && who(q) === 'engine') lastE[q.u] = q.data;
    const sHeld = await waitUntil(() => UNIVERSES.every((u) => packets.some((q) => q.at > stalledAt && q.u === u && who(q) === 'app')), 5000);
    ok(sHeld, 'S2. main holds the wire');
    const sBack = await waitUntil(() => packets.some((q) => q.at > killAt + 200 && who(q) === 'engine'), 15000);
    const eBack = packets.find((q) => q.at > killAt + 200 && who(q) === 'engine');
    ok(sBack, `S3. a restarted engine takes the wire back (${eBack ? `${eBack.at - killAt} ms after main saw the stall` : 'never'})`);
    const sHeldPk = packets.filter((q) => q.at > stalledAt && who(q) === 'app');
    for (const u of UNIVERSES) {
      const mine = sHeldPk.filter((q) => q.u === u);
      ok(lastE[u] && mine.length > 0 && mine.every((q) => q.data.equals(lastE[u])), `S2. universe ${u}: what main held is the engine's last frame, byte for byte (${mine.length} packets)`);
    }
    await sleep(3000);
    const sTail = packets.filter((q) => eBack && q.at > eBack.at + 300);
    ok(sTail.length > 50 && sTail.every((q) => who(q) === 'engine'), `S3. ...and main let go (${sTail.length} packets after: ${[...new Set(sTail.map(who))].join(', ')})`);
    let sGap = 0; const sAround = packets.filter((q) => q.at >= stalledAt);
    for (let i = 1; i < sAround.length; i++) sGap = Math.max(sGap, sAround[i].at - sAround[i - 1].at);
    ok(sGap < 250, `S4. the longest silence on the wire across the stall, the kill and the restart: ${sGap} ms`);
  } finally {
    polling = false;
    if (running) { try { execSync(`taskkill /PID ${running.pid} /F /T`, { stdio: 'ignore' }); } catch { /* gone */ } }
    sock.close();
    console.log(fails ? `\nENGINE HOLD FAILED: ${fails}` : '\nENGINE HOLD OK');
    process.exit(fails ? 1 : 0);
  }
})();
