#!/usr/bin/env node
// E3d — AUTOMATION LANES EVALUATED BY THE ENGINE, checked on a PLAYING show (plans/native-engine.md §4).
//
//   node scripts/test-automation-parity.cjs --packaged <ArtLux.exe>
//
// The engine samples the lanes it owns (a surface's opacity, an effect's speed and intensity — nativeLink
// engineLane) at their clock, EXACTLY, and CHECKS each value against the one the app's overlay holds that frame:
// within the lane's epsilon, the app's own change-detect (`automation: differs`). A looping 6 s show plays itself for 24 s: an image's opacity
// on eased / bezier / hold keys, an effect's speed and intensity. Gate: the engine owns the wire, zero
// differences, thousands of ticks sampled, the DOCUMENT NOT RE-SENT per frame (the point of E3d), and the curve
// visible on the wire. Headless, SCRATCH profile, own processes only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-automation-parity.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6497;
const WORK = path.join(os.tmpdir(), 'artlux-automation-parity');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'automation-parity.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
// The back track's still: a 1-px grid over a gradient (written as a PNG with the repo's pngjs).
const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'));
const png = new PNG({ width: 320, height: 180 });
for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) { const line = x % 20 === 0 || y % 15 === 0; png.data.set([line ? 255 : Math.round(x / 319 * 255), line ? 255 : 60, line ? 255 : Math.round(y / 179 * 255), 255], (y * 320 + x) * 4); }
const still = path.join(WORK, 'still.png'); fs.writeFileSync(still, PNG.sync.write(png));
const k = (t, v, curve, extra) => ({ t, v, ...(curve ? { curve } : {}), ...extra });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sI', name: 'Image', x: 0.02, y: 0.02, width: 0.96, height: 0.45, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: still, opacity: 1 } },
    { id: 'sE', name: 'Effect', x: 0.02, y: 0.52, width: 0.96, height: 0.45, rotation: 0, zIndex: 1, content: { type: 'EFFECT', effectId: 1, paletteId: 0, speed: 0.5, intensity: 0.5, opacity: 1 } },
  ],
  fixtures: [strip('fI', 'sI', 0, 0.25), strip('fE', 'sE', 1, 0.75)],
  timeline: {
    duration: 6, fps: 30, loop: true, layers: [], clips: [],
    automation: [
      { id: 'a1', targetPath: 'surfaces.sI.content.opacity', keyframes: [k(0, 0, 'easeInOutSine'), k(1.5, 1, 'bezier', { cx1: 0.2, cy1: 0.9, cx2: 0.4, cy2: 1.2 }), k(3, 0.2, 'hold'), k(4, 0.8, 'easeOutBounce'), k(5.5, 0)] },
      { id: 'a2', targetPath: 'surfaces.sE.content.speed', keyframes: [k(0, 0.1, 'easeInQuad'), k(6, 3)] },
      { id: 'a3', targetPath: 'surfaces.sE.content.intensity', keyframes: [k(0, 1, 'linear'), k(3, 0.2, 'easeOutElastic'), k(6, 1)] },
    ],
  },
  // The show plays itself: one state whose entry action is PLAY.
  stateMachine: { enabled: true, initialStateId: 'st', states: [{ id: 'st', name: 'Play', x: 100, y: 100, entry: [{ kind: 'play' }] }], transitions: [], regions: [] },
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
    await sleep(10000);
    for (const k of [...all.keys()]) all.set(k, []);   // keep the playing tail: two loops and more
    await sleep(14000);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    sock.close();
  }
  return { last, all, ports, log: fs.readFileSync(logf, 'utf8') };
}

(async () => {
  const B = await run(true);
  let failed = 0;
  const lines = B.log.split(/\r?\n/);
  console.log(lines.filter((l) => /\[engine\].*(owns|automation)/.test(l)).slice(0, 10).join('\n'));
  if (!/owns the wire/.test(B.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  if (!lines.some((l) => /automation: 3 lane\(s\) evaluated by the engine/.test(l))) { console.log('FAIL: the engine was not given the three lanes'); failed++; }
  const diffs = lines.filter((l) => /automation: differs/.test(l));
  const sums = lines.filter((l) => /automation: \d+ tick\(s\) sampled/.test(l)).map((l) => l.match(/(\d+) tick\(s\) sampled, (\d+) difference\(s\).*\(document (\d+)\)/).slice(1).map(Number));
  const last = sums[sums.length - 1] ?? [0, -1, 0];
  console.log(`${last[0]}+ ticks sampled by the engine, ${last[1]} difference(s), last document ${last[2]}`);
  if (diffs.length || last[1] !== 0) { console.log("FAIL: the engine's lanes disagree with the app's:\n" + diffs.slice(0, 8).join('\n')); failed++; }
  if (last[0] < 400) { console.log('FAIL: too few ticks sampled'); failed++; }
  if (last[2] > 6) { console.log(`FAIL: the document was re-sent ${last[2]} times — a curve must not re-send it`); failed++; }
  for (const [uni, name] of [[0, 'image strip (opacity lane)'], [1, 'effect strip (speed + intensity lanes)']]) {
    const s2 = (B.all.get(uni) ?? []).map((d) => d.reduce((a, b) => a + b, 0));
    const lo = Math.min(...s2), hi = Math.max(...s2);
    console.log(`universe ${uni} ${name}: ${s2.length} frames, brightness ${lo}..${hi}`);
    if (s2.length < 200 || hi - lo < (uni === 0 ? 10000 : 1000)) { console.log(`FAIL universe ${uni}: the curve did not move the wire`); failed++; }
  }
  console.log(failed ? `\nautomation parity: ${failed} FAILED` : '\nautomation parity OK');
  process.exit(failed ? 1 : 0);
})();
