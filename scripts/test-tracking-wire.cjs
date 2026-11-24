#!/usr/bin/env node
// E2 — TRACKING BLOBS ON THE WIRE (plans/native-engine.md "E2 tracking": the app computes the blobs, the
// engine draws them — engine blobs.rs, a port of blobPass, fed each tick by trackingDrawable.nativeTickFor).
//
//   node scripts/test-tracking-wire.cjs --packaged <ArtLux.exe>
//
// The repo's LiDAR emitter (scripts/lidar-emitter.cjs, the venue's OSC protocol) runs through both runs: the
// app's Art-Net (run A, no engine) against the engine's (run B, --native-engine, the engine owns the wire). A
// TRACKING surface with trails on a strip and a serpentine matrix. The blobs MOVE, so each engine payload
// must be as close to some app payload as two consecutive app payloads are to each other, the picture must
// move, and the LEDs must be lit. Headless, SCRATCH profile, own processes only.
const { spawn, execSync, fork } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-tracking-wire.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6493;
const WORK = path.join(os.tmpdir(), 'artlux-tracking-wire');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'tracking-wire.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sT', name: 'Floor', x: 0.02, y: 0.02, width: 0.96, height: 0.96, rotation: 0, zIndex: 0, content: { type: 'TRACKING', trackingSource: 'SOL', trail: true, trailSeconds: 1.2, blobSize: 0.08, opacity: 1 } },
  ],
  fixtures: [strip('fT', 'sT', 0, 0.5), { ...matrix('mT', 'sT', 1, 0.05, 0.05), width: 0.9, height: 0.9 }],
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));

const EMITTER = path.join(__dirname, 'lidar-emitter.cjs');
async function run(native) {
  const emitter = fork(EMITTER, ['127.0.0.1', '10000', '2'], { stdio: 'ignore' });
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet', oscEnabled: true, oscListenPort: 10000, oscListenAddress: '' } }));
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const last = new Map(); const all = new Map(); const ports = new Map();
  sock.on('message', (m, rinfo) => {
    if (m.length < 18 || m.toString('latin1', 0, 7) !== 'Art-Net' || m.readUInt16LE(8) !== 0x5000) return;
    const uni = m.readUInt16LE(14); const len = m.readUInt16BE(16);
    const data = Array.from(m.subarray(18, 18 + len));
    last.set(uni, data); ports.set(uni, rinfo.port);
    if (!all.has(uni)) all.set(uni, []); all.get(uni).push(data);
  });
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));
  const logf = path.join(WORK, `run-${native ? 'engine' : 'app'}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, ...(native ? ['--native-engine'] : [])], { env, stdio: ['ignore', log, log] });
  try {
    await sleep(14000);
    for (const k of [...all.keys()]) all.set(k, []);   // keep only the settled tail
    await sleep(4000);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    emitter.kill();
    sock.close();
  }
  return { last, all, ports, log: fs.readFileSync(logf, 'utf8') };
}

(async () => {
  const A = await run(false);
  await sleep(1500);
  const B = await run(true);
  const engineLines = B.log.split(/\r?\n/).filter((l) => /\[engine\].*(owns|keeps|sources)/.test(l)).slice(0, 8);
  console.log(engineLines.join('\n'));
  let failed = 0;
  if (!/owns the wire/.test(B.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  const med = (xs) => xs.slice().sort((x, y) => x - y)[xs.length >> 1];
  for (const uni of [0, 1]) {
    const name = uni ? 'matrix' : 'strip';
    const appSeq = A.all.get(uni) ?? [], engSeq = B.all.get(uni) ?? [];
    if (!appSeq.length || !engSeq.length) { console.log(`FAIL universe ${uni} ${name}: missing (app ${appSeq.length}, engine ${engSeq.length})`); failed++; continue; }
    const mad = (x, y) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0) / x.length;
    const near = engSeq.map((pb) => Math.min(...appSeq.map((pa) => mad(pa, pb))));
    const step = med(appSeq.slice(1).map((pa, i) => mad(pa, appSeq[i])).filter((x) => x > 0));
    const moved = new Set(engSeq.map((x) => x.join(','))).size;
    const lit = Math.max(...engSeq.map((p) => p.filter((v) => v > 20).length));
    const ok = moved >= 10 && lit >= 6 && med(near) <= Math.max(0.5, step);
    if (!ok) failed++;
    console.log(`${ok ? '' : 'FAIL '}universe ${uni} ${name}: engine payloads ${engSeq.length} (${moved} distinct, up to ${lit} channels lit), mean |delta| to nearest app payload: median ${med(near).toFixed(2)} (the app's own frame-to-frame step: ${step?.toFixed(2)})`);
  }
  console.log('sender ports (app run / engine run):', [...A.ports.values()][0], '/', [...B.ports.values()][0]);
  console.log(failed ? `\ntracking wire: ${failed} FAILED` : '\ntracking wire OK');
  process.exit(failed ? 1 : 0);
})();
