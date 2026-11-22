#!/usr/bin/env node
// Item 2d step 2 (plans/native-engine.md) — the engine's RUNTIME camera reader (camshared::SharedIn) beside a
// real Chromium holder. Owner's decision 2026-11-22: the app keeps its cameras, the engine reads them shared.
// The holder is engine/spikes/camera-shared: getUserMedia exactly as services/contentSource.ts opens a camera.
//
//   A  beside:      holder holds; the engine reads 6 s.     GATE: the engine gets ≥ 90% of the holder's frames
//                   over the same seconds, AND the holder's own rate does not drop (≥ 90% of its rate before).
//   B  holder goes: holder stops its track mid-read.         REPORTED: what the engine's stream does after.
//   D  engine first: the engine reads, then the holder opens. GATE: the holder still gets its own format (1280×720).
//   E  MJPEG holder: cam.rs's exclusive reader holds MJPEG.   GATE: the engine reads the compressed frames, ≥ 90%.
//   C  no holder:   the engine alone.                        REPORTED: does Windows open a shared read at all.
//
//   node scripts/test-camera-shared.cjs [--camera <index>]     (index from `artlux-engine --cameras`)
// Needs a camera Media Foundation sees (a UVC webcam; not the PS3 Eye, not NDI virtual cameras).
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = process.env.ARTLUX_ENGINE_EXE || path.join(ROOT, 'engine', 'target', 'release', 'artlux-engine.exe');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const IDX = (() => { const i = process.argv.indexOf('--camera'); return i > 0 ? process.argv[i + 1] : '0'; })();
const WORK = path.join(os.tmpdir(), 'artlux-camera-shared');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = execFileSync(ENGINE, ['--cameras'], { encoding: 'utf8' });
console.log(list.trim());
if (!new RegExp(`^\\[${IDX}\\] `, 'm').test(list)) { console.log(`FAIL: no camera ${IDX} — plug a UVC webcam in`); process.exit(1); }

function holder(dir, hold, post) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, SPIKE_OUT: dir, HOLD_SECS: String(hold), POST_SECS: String(post) };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, [path.join(ROOT, 'engine', 'spikes', 'camera-shared')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout.on('data', (d) => process.stdout.write(String(d)));
  const read = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'holder.json'), 'utf8')); } catch { return null; } };
  const done = new Promise((r) => p.on('exit', r));
  return { read, done };
}
async function untilHolding(h) {
  for (let k = 0; k < 120; k++) { const s = h.read(); if (s?.error) throw new Error(`holder: ${s.error}`); if (s?.holding && s.frames > 10) return s; await sleep(250); }
  throw new Error('the holder never got frames');
}
// The engine's run, timed against the holder's clock: returns its per-second counts and its own report.
function engine(secs, prefix) {
  return new Promise((resolve) => {
    const args = ['--camera-shared', IDX, String(secs)]; if (prefix) args.push(prefix);
    const p = spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out }));
  });
}
const inWindow = (times, a, b) => times.filter((t) => t >= a && t < b).length;

(async () => {
  let fail = 0;
  // ── A: beside a holder ────────────────────────────────────────────────────────────────────────────────
  {
    const h = holder(path.join(WORK, 'a'), 16, 0);
    const s0 = await untilHolding(h);
    console.log(`A holder: ${s0.settings.width}x${s0.settings.height} @ ${s0.settings.frameRate} (Chromium's choice)`);
    await sleep(3000); // the holder's rate on its own
    const tStart = h.read().t;
    const r = await engine(6, path.join(WORK, 'a-frame'));
    const tEnd = h.read().t;
    await h.done;
    process.stdout.write(r.out.split('\n').filter((l) => !/^SHARED t=/.test(l)).join('\n'));
    const st = JSON.parse(fs.readFileSync(path.join(WORK, 'a', 'holder.json'), 'utf8'));
    const n = Number(/SHARED: (\d+) frames/.exec(r.out)?.[1] ?? 0);
    const openMs = Number(/open in (\d+) ms/.exec(r.out)?.[1] ?? 0);
    // The engine counted for 6 s after it opened; the holder's frames over those same 6 s.
    const hs = inWindow(st.times, tStart + openMs, tStart + openMs + 6000);
    const before = inWindow(st.times, tStart - 3000, tStart) / 3;
    const during = hs / 6;
    console.log(`A engine ${n} frames in 6 s · holder ${hs} in the same 6 s · holder ${before.toFixed(1)} fps before, ${during.toFixed(1)} fps during (engine ran ${((tEnd - tStart) / 1000).toFixed(1)} s)`);
    if (r.code !== 0 || n < 0.9 * hs) { console.log('FAIL A: the engine missed frames the holder got'); fail++; }
    else if (during < 0.9 * before) { console.log('FAIL A: the holder slowed down while the engine read'); fail++; }
    else console.log('PASS A: every frame, the holder undisturbed');
  }
  // ── B: the holder leaves mid-read ─────────────────────────────────────────────────────────────────────
  {
    const h = holder(path.join(WORK, 'b'), 7, 6);
    await untilHolding(h);
    const tStart = h.read().t;
    const r = await engine(10, null);
    await h.done;
    const st = JSON.parse(fs.readFileSync(path.join(WORK, 'b', 'holder.json'), 'utf8'));
    const openMs = Number(/open in (\d+) ms/.exec(r.out)?.[1] ?? 0);
    const series = [...r.out.matchAll(/SHARED t=(\d+) frames=(\d+)/g)].map((m) => Number(m[2]));
    console.log(`B the holder stopped its track ${((st.stoppedAt - tStart - openMs) / 1000).toFixed(1)} s into the engine's read; engine frames per second: ${series.map((v, k) => v - (series[k - 1] ?? 0)).join(' ')}`);
    const why = /SHARED: stopped — (.*)/.exec(r.out)?.[1];
    console.log(`B ${why ? `the engine's stream reported: ${why}` : 'the engine reported no error'}`);
  }
  // ── D: the engine first, the app after ────────────────────────────────────────────────────────────────
  // The engine reading alone must not take the camera from the app: Chromium still opens it, in ITS format.
  {
    const run = engine(10, null);
    await sleep(2500);
    const h = holder(path.join(WORK, 'd'), 5, 0);
    let s = null;
    try { s = await untilHolding(h); } catch (e) { console.log(`FAIL D: ${e.message} (the engine opened first)`); fail++; }
    const r = await run; await h.done;
    if (s) {
      const series = [...r.out.matchAll(/SHARED t=(\d+) frames=(\d+)/g)].map((m) => Number(m[2]));
      const ok = s.settings.width === 1280 && s.settings.height === 720;
      console.log(`D holder after the engine: ${s.settings.width}x${s.settings.height}; engine frames per second: ${series.map((v, k) => v - (series[k - 1] ?? 0)).join(' ')}`);
      if (!ok) { console.log('FAIL D: the app did not get its own format'); fail++; } else console.log('PASS D: the app opens its camera, in its format, with the engine already reading');
    }
  }
  // ── E: an MJPEG controller ─────────────────────────────────────────────────────────────────────────────
  // Chromium sometimes picks MJPEG (seen on the first open after plugging in). Windows then converts nothing
  // for a shared reader, and the engine reads the compressed frames. Forced here with the engine's own
  // EXCLUSIVE reader (cam.rs) as the holder, in MJPEG.
  {
    const hp = spawn(ENGINE, ['--camera-grab', IDX, '10', path.join(WORK, 'e-hold'), '1280x720', 'MJPG'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let hout = ''; hp.stdout.on('data', (d) => { hout += d; });
    const hdone = new Promise((r) => hp.on('exit', r));
    await sleep(3000);
    const r = await engine(4, path.join(WORK, 'e-frame'));
    await hdone;
    const n = Number(/SHARED: (\d+) frames/.exec(r.out)?.[1] ?? 0);
    const hn = Number(/(\d+) frames in 10 s/.exec(hout)?.[1] ?? 0);
    const fmt = /the controller's format: (\S+)/.exec(r.out)?.[1];
    let meta = null; try { meta = JSON.parse(fs.readFileSync(path.join(WORK, 'e-frame.json'), 'utf8')); } catch { /* none */ }
    console.log(`E controller ${fmt}; engine ${n} frames in 4 s (holder ${hn} in 10 s); frame ${meta ? `${meta.format} ${meta.w}x${meta.h}` : 'none'}`);
    if (fmt !== 'MJPG' || !meta || meta.format !== 'MJPG' || n < 0.9 * (hn / 10) * 4) { console.log('FAIL E: no MJPEG frames beside an MJPEG controller'); fail++; }
    else console.log('PASS E: MJPEG frames beside an MJPEG controller');
  }
  // ── C: nobody holds the camera ────────────────────────────────────────────────────────────────────────
  {
    const r = await engine(3, null);
    console.log(`C alone: ${r.out.split('\n').filter((l) => /SHARED: /.test(l)).join(' | ')}`);
  }
  console.log(fail ? `${fail} gate(s) FAILED` : 'camera-shared: PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
