#!/usr/bin/env node
// E3c — THE ENGINE EVALUATES THE TIMELINE'S TIME, checked on a PLAYING show (plans/native-engine.md §4).
//
//   node scripts/test-clock-parity.cjs --packaged <ArtLux.exe>
//
// The engine evaluates every composited track's clip alpha (content opacity × fades) and clip-local time from
// the playhead (eval.rs, runtime evaluate_clock) and CHECKS each value against the one the app still sends — the
// parity harness running on the show itself, every frame. A looping 6 s timeline plays itself (a state whose
// entry is PLAY) for 24 s: overlapping fades, a gap, a trimmed clip, content opacity, the playhead crossing clip
// boundaries and wrapping. Gate: the engine owns the wire, zero differences, a new document at each boundary,
// and the fades visible on the wire. Headless, SCRATCH profile, own processes only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-clock-parity.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6496;
const WORK = path.join(os.tmpdir(), 'artlux-clock-parity');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'clock-parity.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
// The back track's still: a 1-px grid over a gradient (written as a PNG with the repo's pngjs).
const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'));
const png = new PNG({ width: 320, height: 180 });
for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) { const line = x % 20 === 0 || y % 15 === 0; png.data.set([line ? 255 : Math.round(x / 319 * 255), line ? 255 : 60, line ? 255 : Math.round(y / 179 * 255), 255], (y * 320 + x) * 4); }
const still = path.join(WORK, 'still.png'); fs.writeFileSync(still, PNG.sync.write(png));
const SHADER = 'vec4 shaderColor(vec2 uv) { return vec4(0.5 + 0.5 * sin(uv.x * 12.0), uv.y, 0.3, 1.0); }';
// A PLAYING, LOOPING timeline over 0–6 s whose every track fades: overlapping fades, a gap (no clip), a trimmed
// clip (inPoint), content opacity — so the playhead crosses clip boundaries and the alphas move every frame.
const clip = (id, layerId, content, start, duration, extra) => ({ id, layerId, name: id, path: '', content, start, duration, inPoint: 0, ...extra });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sP', name: 'Program', x: 0.02, y: 0.02, width: 0.96, height: 0.45, rotation: 0, zIndex: 0, content: { type: 'PROGRAM', opacity: 1 } },
    { id: 'sL', name: 'Still track', x: 0.02, y: 0.52, width: 0.96, height: 0.45, rotation: 0, zIndex: 1, content: { type: 'LAYER', layerId: 'L1', opacity: 1 } },
  ],
  fixtures: [strip('fP', 'sP', 0, 0.25), strip('fL', 'sL', 1, 0.75)],
  timeline: {
    duration: 6, fps: 30, loop: true,
    layers: [
      { id: 'L1', name: 'Still', opacity: 1 },
      { id: 'L2', name: 'Shader', opacity: 0.7, blendMode: 'add' },
    ],
    clips: [
      clip('a1', 'L1', { type: 'IMAGE', url: still, opacity: 0.9 }, 0, 3, { fadeIn: 1, fadeOut: 1 }),
      clip('a2', 'L1', { type: 'IMAGE', url: still, opacity: 1 }, 3.5, 2.5, { fadeIn: 0.5, inPoint: 2 }),
      clip('b1', 'L2', { type: 'SHADER', shaderSource: SHADER, opacity: 1 }, 0, 6, { fadeIn: 2, fadeOut: 1.5, inPoint: 1.5 }),
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
  console.log(B.log.split(/\r?\n/).filter((l) => /\[engine\].*(owns|keeps|clock)/.test(l)).slice(0, 12).join('\n'));
  if (!/owns the wire/.test(B.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  const evals = B.log.split(/\r?\n/).filter((l) => /clock: \d+ track\(s\) evaluated/.test(l));
  const diffs = B.log.split(/\r?\n/).filter((l) => /clock: differs/.test(l));
  const lastN = evals.length ? +evals[evals.length - 1].match(/; (\d+) difference/)[1] : -1;
  console.log(`${evals.length} documents evaluated from the playhead; ${diffs.length} difference line(s); running total ${lastN}`);
  if (evals.length < 6) { console.log('FAIL: the playhead did not cross enough clip boundaries (expected a new document at each, over 2+ loops)'); failed++; }
  if (diffs.length || lastN !== 0) { console.log('FAIL: the engine\'s clock disagrees with the app\'s:\n' + diffs.slice(0, 8).join('\n')); failed++; }
  // The fades must actually MOVE the wire: each strip's brightness over the playing tail.
  for (const [uni, name] of [[0, 'program strip'], [1, 'still-track strip']]) {
    const sums = (B.all.get(uni) ?? []).map((d) => d.reduce((a, b) => a + b, 0));
    const lo = Math.min(...sums), hi = Math.max(...sums);
    console.log(`universe ${uni} ${name}: ${sums.length} frames, brightness ${lo}..${hi}`);
    if (sums.length < 200 || hi - lo < 20000 || hi === 0) { console.log(`FAIL universe ${uni}: the fades did not play on the wire`); failed++; }
  }
  console.log(failed ? `\nclock parity: ${failed} FAILED` : '\nclock parity OK');
  process.exit(failed ? 1 : 0);
})();
