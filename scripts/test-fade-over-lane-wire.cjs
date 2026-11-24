#!/usr/bin/env node
// E3d follow-up — A SCENE FADE OVER A RUNNING LANE, ON THE WIRE (plans/native-engine.md §4).
//
//   node scripts/test-fade-over-lane-wire.cjs --packaged <ArtLux.exe>
//
// The engine samples a surface's opacity lane itself (E3d) — EXCEPT while a scene fade runs, because the fade
// lands ON the curve (transitions.toDynamic): frameEngine then withholds the lanes and the document carries the
// fully resolved surfaces, every frame. Every fade therefore hands the lane from the engine to the app and back.
// The risk is the HANDOVER: one frame of the authored value (no lane) or of a stale document would flash on the
// wire as the fade starts or lands.
//
// The show: two states, each bound to a scene whose own timeline runs an opacity curve on the same white
// surface (A: 0.2 → 1 → 0.2, B: 1 → 0.3 → 1, looping 6 s); the state machine crossfades A → B → A … every few
// seconds over 3 s, so fades start and land on moving curves. Two runs: A (the app alone) and B
// (--native-engine, the engine owns the wire); each records universe 0 (one 150-LED strip on the surface) per
// ArtDmx frame. A frame's level is its mean byte; a FLASH is a step between consecutive frames. Gate: the
// engine owned the wire, handed the lane over at least four times (`automation: 0 lane(s)` / `1 lane(s)` in its
// log), never logged `automation: differs`, and its largest step is no larger than the app's own (+ 8) and
// under 40 — the curves and fades move ≤ ~6 a frame. Headless, SCRATCH profile, own processes only.
'use strict';
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-fade-over-lane-wire.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6493;
const WORK = path.join(os.tmpdir(), 'artlux-fade-over-lane');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'));
const png = new PNG({ width: 64, height: 16 });
png.data.fill(255);
const white = path.join(WORK, 'white.png'); fs.writeFileSync(white, PNG.sync.write(png));

const surface = { id: 'sW', name: 'White', x: 0.02, y: 0.02, width: 0.96, height: 0.96, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: white, opacity: 1 } };
const fixture = { id: 'fW', name: 'strip', surfaceId: 'sW', x: 0.03, y: 0.5, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: 0, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 };
const timelineOf = (a, b) => ({
  duration: 6, fps: 30, loop: true, layers: [], clips: [],
  automation: [{ id: 'op', targetPath: 'surfaces.sW.content.opacity', keyframes: [{ t: 0, v: a, curve: 'linear' }, { t: 3, v: b, curve: 'linear' }, { t: 6, v: a }] }],
});
const scene = (id, name, opacity, tl) => ({ id, name, fadeSec: 3, surfaces: [{ ...surface, content: { ...surface.content, opacity } }], fixtures: [fixture], globalBrightness: 1, groups: [], timeline: tl });
const project = path.join(WORK, 'fade-over-lane.artlux');
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [surface], fixtures: [fixture], controllers: [], groups: [], cueBanks: [],
  scenes: [scene('scA', 'A', 0.6, timelineOf(0.2, 1)), scene('scB', 'B', 0.4, timelineOf(1, 0.3))],
  timeline: timelineOf(0.2, 1),
  stateMachine: {
    enabled: true, initialStateId: 'stA', regions: [],
    states: [
      { id: 'stA', name: 'A', x: 100, y: 100, sceneId: 'scA', entry: [{ kind: 'play' }] },
      { id: 'stB', name: 'B', x: 300, y: 100, sceneId: 'scB', entry: [{ kind: 'play' }] },
    ],
    transitions: [
      { id: 'tAB', from: 'stA', to: 'stB', trigger: { kind: 'afterDelay', seconds: 4.3 }, fadeSec: 3 },
      { id: 'tBA', from: 'stB', to: 'stA', trigger: { kind: 'afterDelay', seconds: 5.1 }, fadeSec: 3 },
    ],
  },
}, null, 2));

async function run(native) {
  // The previous run's processes can hold the profile for a moment after taskkill: retry, do not fail.
  for (let i = 0; ; i++) { try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); } }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet' } }));
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const levels = [];
  sock.on('message', (m) => {
    if (m.length < 18 || m.toString('latin1', 0, 7) !== 'Art-Net' || m.readUInt16LE(8) !== 0x5000 || m.readUInt16LE(14) !== 0) return;
    const d = m.subarray(18, 18 + m.readUInt16BE(16));
    let s = 0; for (let i = 0; i < 450 && i < d.length; i++) s += d[i];
    levels.push(s / 450);
  });
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));
  const logf = path.join(WORK, `run-${native ? 'engine' : 'app'}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, ...(native ? ['--native-engine'] : [])], { env, stdio: ['ignore', log, log] });
  try { await sleep(36000); } finally { try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } sock.close(); }
  // The first seconds are boot (black, then the engine taking over): judged from the first lit frame + 2 s.
  fs.writeFileSync(path.join(WORK, `levels-${native ? 'engine' : 'app'}.json`), JSON.stringify(levels));
  const lit = levels.findIndex((l) => l > 5);
  const body = lit < 0 ? [] : levels.slice(lit + 90);
  let maxStep = 0, at = -1;
  for (let i = 1; i < body.length; i++) { const s = Math.abs(body[i] - body[i - 1]); if (s > maxStep) { maxStep = s; at = i; } }
  const lo = Math.min(...body), hi = Math.max(...body);
  return { frames: body.length, maxStep, around: at < 0 ? [] : body.slice(Math.max(0, at - 3), at + 3).map((x) => x.toFixed(1)), lo, hi, lines: fs.readFileSync(logf, 'utf8').split(/\r?\n/) };
}

(async () => {
  const A = await run(false);
  const B = await run(true);
  let failed = 0;
  for (const [n, r] of [['app', A], ['engine', B]]) console.log(`${n}: ${r.frames} frames judged, level ${r.lo.toFixed(1)}–${r.hi.toFixed(1)}, largest step ${r.maxStep.toFixed(1)} (around it: ${r.around.join(' ')})`);
  const laneLog = B.lines.filter((l) => /automation: \d+ lane\(s\) evaluated by the engine/.test(l));
  const handovers = laneLog.filter((l) => /automation: 0 lane\(s\)/.test(l)).length;
  console.log(`engine: ${laneLog.length} lane hand-over line(s), ${handovers} to the app (a fade)`);
  if (!B.lines.some((l) => /\[engine\] owns the wire/.test(l))) { console.log('FAIL: the engine never owned the wire'); failed++; }
  if (handovers < 4) { console.log('FAIL: fewer than four fades handed the lane over'); failed++; }
  if (B.lines.some((l) => /automation: differs/.test(l))) { console.log('FAIL: the engine\'s lane disagreed with the app\'s'); failed++; }
  if (A.frames < 600 || B.frames < 600) { console.log('FAIL: too few frames on the wire'); failed++; }
  if (A.hi - A.lo < 60 || B.hi - B.lo < 60) { console.log('FAIL: the curves did not move the wire'); failed++; }
  if (B.maxStep > Math.max(A.maxStep + 8, 0) || B.maxStep >= 40) { console.log('FAIL: the engine flashed — a step the app does not make'); failed++; }
  console.log(failed ? `\nfade over lane wire: ${failed} FAILED` : '\nfade over lane wire OK');
  process.exit(failed ? 1 : 0);
})();
