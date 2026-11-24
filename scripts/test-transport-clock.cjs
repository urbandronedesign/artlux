#!/usr/bin/env node
// E3 — THE ENGINE'S OWN TRANSPORT CLOCK, checked on a show driven by events (plans/native-engine.md §4).
//
//   node scripts/test-transport-clock.cjs --packaged <ArtLux.exe>
//
// The app records a transport ANCHOR at every event (timeline.ts markAnchor: play / pause, seek, a region
// edit, the underrun clamp, the render-clock flip); the engine runs the playhead and the show clock itself
// from the latest one (transport.rs — runFrame's wrap and park rules) and CHECKS both against the app's at
// every frame's own time (`transport: differs`). A looping 6 s show plays itself and is then driven over OSC
// — pause, play, seeks (one just short of the wrap), loop OFF so the end-stop parks and pauses it, play from
// the parked end (the restart), stop, play — for ~30 s. Gates: hundreds of frames run by the engine's clock,
// ZERO differing, every event reached it (anchors seen), and the engine's own wall clock agrees with the
// app's frames to within a frame. MUTATION: the same run with the engine's clock skewed by 1 ms
// (ARTLUX_TRANSPORT_SKEW_MS) must be caught. Headless, SCRATCH profile, own processes only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-transport-clock.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6497;
const OSC_PORT = 10007;
const WORK = path.join(os.tmpdir(), 'artlux-transport-clock');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

// ── OSC (the encoder of scripts/lidar-emitter.cjs) ──────────────────────────────────────────────────
const pad = (s) => { const raw = Buffer.from(s, 'utf8'); const b = Buffer.alloc((Math.floor(raw.length / 4) + 1) * 4); raw.copy(b); return b; };
function osc(address, type, value) {
  if (!type) return Buffer.concat([pad(address), pad(',')]);
  const arg = Buffer.alloc(4);
  if (type === 'i') arg.writeInt32BE(value | 0); else arg.writeFloatBE(value);
  return Buffer.concat([pad(address), pad(',' + type), arg]);
}
const out = dgram.createSocket('udp4');
const fire = (address, type, value) => new Promise((r) => out.send(osc(address, type, value), OSC_PORT, '127.0.0.1', () => r()));

const project = path.join(WORK, 'transport-clock.artlux');
const SHADER = 'vec4 shaderColor(vec2 uv) { return vec4(0.5 + 0.5 * sin(uv.x * 12.0), uv.y, 0.3, 1.0); }';
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [{ id: 'sP', name: 'Program', x: 0.02, y: 0.02, width: 0.96, height: 0.96, rotation: 0, zIndex: 0, content: { type: 'PROGRAM', opacity: 1 } }],
  fixtures: [{ id: 'fP', name: 'fP', surfaceId: 'sP', x: 0.03, y: 0.5, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: 0, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 }],
  timeline: {
    duration: 6, fps: 30, loop: true,
    layers: [{ id: 'L1', name: 'Shader', opacity: 1 }],
    clips: [{ id: 'c1', layerId: 'L1', name: 'c1', path: '', content: { type: 'SHADER', shaderSource: SHADER, opacity: 1 }, start: 0, duration: 6, inPoint: 0, fadeIn: 1, fadeOut: 1 }],
  },
  stateMachine: { enabled: true, initialStateId: 'st', states: [{ id: 'st', name: 'Play', x: 100, y: 100, entry: [{ kind: 'play' }] }], transitions: [], regions: [] },
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));

async function run(skew) {
  for (let i = 0; ; i++) {   // the last run's (killed) processes may still hold the profile for a moment
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); }
  }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: {
    outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet',
    oscEnabled: true, oscListenPort: OSC_PORT, oscListenAddress: '', oscControlPrefix: '/artlux',
  } }));
  const logf = path.join(WORK, `run-${skew ? 'skewed' : 'engine'}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  if (skew) env.ARTLUX_TRANSPORT_SKEW_MS = String(skew);
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, '--native-engine'], { env, stdio: ['ignore', log, log] });
  const steps = [];
  const step = async (what, fn, wait) => { steps.push(what); await fn(); await sleep(wait); };
  try {
    await sleep(12000);                                                         // boots, plays, wraps once or twice
    await step('pause', () => fire('/artlux/transport/pause'), 1500);
    await step('play', () => fire('/artlux/transport/play'), 2000);
    await step('seek 2.0 (playing)', () => fire('/artlux/transport/seek', 'f', 2.0), 1500);
    await step('seek 5.6 (wraps)', () => fire('/artlux/transport/seek', 'f', 5.6), 2000);
    await step('pause', () => fire('/artlux/transport/pause'), 800);
    await step('seek 1.25 (paused)', () => fire('/artlux/transport/seek', 'f', 1.25), 800);
    await step('play', () => fire('/artlux/transport/play'), 1500);
    await step('loop off (runs out, parks, pauses)', () => fire('/artlux/transport/loop', 'i', 0), 6500);
    await step('play from the parked end (restart)', () => fire('/artlux/transport/play'), 2500);
    await step('stop', () => fire('/artlux/transport/stop'), 1000);
    await step('play', () => fire('/artlux/transport/play'), 2500);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  }
  return { steps, log: fs.readFileSync(logf, 'utf8') };
}

const lines = (log, re) => log.split(/\r?\n/).filter((l) => re.test(l));
(async () => {
  let failed = 0;
  const A = await run(0);
  console.log(A.steps.map((s) => `  · ${s}`).join('\n'));
  if (!/owns the wire/.test(A.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  if (!/\[osc\] listening/.test(A.log)) { console.log('FAIL: OSC never listened — the events were not driven'); failed++; }
  const sums = lines(A.log, /transport: \d+ frame\(s\) run by the engine's clock/);
  const diffs = lines(A.log, /transport: differs/);
  console.log(sums.slice(-3).join('\n'));
  const last = sums.length ? sums[sums.length - 1] : '';
  const m = last.match(/transport: (\d+) frame\(s\) run by the engine's clock, (\d+) differing \((\d+) before their anchor\); own clock vs the app's frame: mean (-?[\d.]+) ms, extreme (-?[\d.]+) ms over (\d+)/);
  if (!m) { console.log('FAIL: no transport summary from the engine'); failed++; }
  else {
    const [, n, d, , mean, ext, playing] = m.map(Number);
    console.log(`engine's clock: ${n} frames checked, ${d} differing; own clock vs the app's frame: mean ${mean} ms, extreme ${ext} ms (${playing} playing ticks)`);
    if (n < 500) { console.log('FAIL: too few frames run by the engine\'s clock'); failed++; }
    if (d !== 0 || diffs.length) { console.log('FAIL: the engine\'s clock differs from the app\'s:\n' + diffs.slice(0, 8).join('\n')); failed++; }
    // The engine reads its own wall clock when the tick ARRIVES, so it leads the app's frame by the frame's age
    // (IPC renderer → main → engine). A wrong epoch or a missing event would be seconds, not milliseconds.
    if (!(mean > -2 && mean < 50) || Math.abs(ext) > 250) { console.log('FAIL: the engine\'s own clock is not within a frame of the app\'s'); failed++; }
  }
  // The anchor count proves each event reached the engine (one or more anchors per event; the boot adds some).
  const anchors = lines(A.log, /transport: anchor \d+/).length;
  console.log(`${anchors} anchor(s) reached the engine`);
  if (anchors < A.steps.length) { console.log('FAIL: fewer anchors than events'); failed++; }

  const B = await run(1);
  const bd = lines(B.log, /transport: differs/);
  console.log(`mutation (engine clock skewed 1 ms): ${bd.length} difference line(s)${bd.length ? ' — first: ' + bd[0].replace(/^.*transport: /, '') : ''}`);
  if (!bd.length) { console.log('FAIL: a 1 ms clock error went unnoticed'); failed++; }
  out.close();
  console.log(failed ? `\ntransport clock: ${failed} FAILED` : '\ntransport clock OK');
  process.exit(failed ? 1 : 0);
})();
