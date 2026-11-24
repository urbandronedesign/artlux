#!/usr/bin/env node
// E3b — VIDEO CLIPS ON TIMELINE TRACKS through the native engine (plans/native-engine.md E3b: a track's HAP / MP4
// clip is drawn by the engine from the frame the app shows — its index / VideoFrame timestamp rides the tick —
// and composited by comp.rs).
//
//   node scripts/test-timeline-video-wire.cjs --packaged <ArtLux.exe> [--hap <clip.mov>]
//
// The app's Art-Net (run A, no engine) against the engine's (run B, --native-engine). The playhead rests at 0,
// so every track holds one frame and the bytes can be compared exactly:
//   - an MP4 track (engine/testdata/still-avc-1280x720.mp4) alone on a LAYER surface (strip + matrix);
//   - a HAP track alone on a LAYER surface (strip) — given with --hap (or ARTLUX_HAP);
//   - the PROGRAM: the HAP track over the MP4 track, ADD at 0.5 (strip).
// Within 1 on every channel, every universe lit. Headless, SCRATCH profile, own processes only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-timeline-video-wire.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6495;
const hk = process.argv.indexOf('--hap');
const HAP = hk > 0 ? path.resolve(process.argv[hk + 1]) : process.env.ARTLUX_HAP;
if (!HAP || !fs.existsSync(HAP)) { console.error('needs a HAP .mov: --hap <file> (or ARTLUX_HAP)'); process.exit(2); }
const MP4 = path.join(__dirname, '..', 'engine', 'testdata', 'still-avc-1280x720.mp4');
const WORK = path.join(os.tmpdir(), 'artlux-timeline-video-wire');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'timeline-video-wire.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
const vclip = (id, layerId, p) => ({ id, layerId, name: id, path: p, start: 0, duration: 60, inPoint: 0 });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sM', name: 'MP4 track', x: 0.02, y: 0.02, width: 0.96, height: 0.3, rotation: 0, zIndex: 0, content: { type: 'LAYER', layerId: 'LM', opacity: 1 } },
    { id: 'sH', name: 'HAP track', x: 0.02, y: 0.36, width: 0.96, height: 0.3, rotation: 0, zIndex: 1, content: { type: 'LAYER', layerId: 'LH', opacity: 1 } },
    { id: 'sP', name: 'Program', x: 0.02, y: 0.7, width: 0.96, height: 0.28, rotation: 0, zIndex: 2, content: { type: 'PROGRAM', opacity: 1 } },
  ],
  fixtures: [strip('fM', 'sM', 0, 0.17), matrix('mM', 'sM', 1, 0.1, 0.05), strip('fH', 'sH', 2, 0.51), strip('fP', 'sP', 3, 0.84)],
  timeline: {
    duration: 60, fps: 30,
    layers: [
      { id: 'LH', name: 'HAP', opacity: 0.5, blendMode: 'add' },
      { id: 'LM', name: 'MP4', opacity: 1 },
    ],
    clips: [vclip('cH', 'LH', HAP), vclip('cM', 'LM', MP4)],
  },
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));

async function run(native) {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet' } }));
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
    sock.close();
  }
  return { last, all, ports, log: fs.readFileSync(logf, 'utf8') };
}

(async () => {
  const A = await run(false);
  await sleep(1500);
  const B = await run(true);
  const engineLines = B.log.split(/\r?\n/).filter((l) => /\[engine\].*(owns|keeps|raster|sources)/.test(l)).slice(0, 8);
  console.log(engineLines.join('\n'));
  let failed = 0;
  if (!/owns the wire/.test(B.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  const names = { 0: 'MP4 track strip', 1: 'MP4 track matrix', 2: 'HAP track strip', 3: 'program strip (HAP add 0.5 over MP4)' };
  for (const uni of [0, 1, 2, 3]) {
    const a = A.last.get(uni), b = B.last.get(uni);
    if (!a || !b) { console.log(`FAIL universe ${uni} ${names[uni]}: missing (app ${!!a}, engine ${!!b})`); failed++; continue; }
    let max = 0, diff = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d) diff++; }
    if (max > 1) failed++;
    // Identical BLACK would prove nothing: the type must actually reach the LEDs.
    const lit = a.filter((v) => v > 20).length;
    if (lit < 10) failed++;
    console.log(`${max > 1 || lit < 10 ? 'FAIL ' : ''}universe ${uni} ${names[uni]}: ${diff} of ${a.length} channels differ, max ${max}, ${lit} channels lit${diff === 0 ? '  IDENTICAL' : ''}`);
  }
  console.log('sender ports (app run / engine run):', [...A.ports.values()][0], '/', [...B.ports.values()][0]);
  console.log(failed ? `\ntimeline video wire: ${failed} FAILED` : '\ntimeline video wire OK');
  process.exit(failed ? 1 : 0);
})();
