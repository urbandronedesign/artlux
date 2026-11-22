#!/usr/bin/env node
// Item 2d steps 2–3 (plans/native-engine.md) — the engine's RUNTIME camera reader (camshared::SharedIn) beside a
// real Chromium holder. Owner's decision 2026-11-22: the app keeps its cameras, the engine reads them shared.
// The holder is engine/spikes/camera-shared: getUserMedia exactly as services/contentSource.ts opens a camera.
//
//   A  beside:      holder holds; the engine reads 6 s.     GATE: the engine gets ≥ 90% of the holder's frames
//                   over the same seconds, AND the holder's own rate does not drop (≥ 90% of its rate before).
//   B  holder goes: holder stops its track mid-read.         REPORTED: what the engine's stream does after.
//   D  engine first: the engine reads, then the holder opens. GATE: the holder still gets its own format (1280×720).
//   E  MJPEG holder: cam.rs's exclusive reader holds MJPEG.   GATE: the engine reads the compressed frames, ≥ 90%.
//   F  the picture: paired frames, the engine's conversion vs the app's 1:1 draw.
//                                                            GATE: within 1 on at most 0.1% of channels.
//   G  identity: the app's label (+ its picture fingerprint) → the engine's camera; a decoy twin (test-only
//                ARTLUX_CAM_TWIN) shows the picture decides between identical models, or refuses. GATE.
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

function holder(dir, hold, post, extra = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, SPIKE_OUT: dir, HOLD_SECS: String(hold), POST_SECS: String(post), ...extra };
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
function engine(secs, prefix, custom) {
  return new Promise((resolve) => {
    const args = custom ?? ['--camera-shared', IDX, String(secs)]; if (prefix) args.push(prefix);
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
  // ── F: the PICTURE — the engine's frame drawn as the app draws the same frame ────────────────────────────
  // Both sides dump frames over the same second; each engine frame is paired with the app frame of the SAME
  // image, by content (Chromium stamps an image one frame later than Windows does, measured ~64–70 ms at
  // 15 fps, so the nearest timestamp is the wrong frame). The engine's is converted by artlux-engine
  // --camera-convert (cam::picture: requantised to the app's limited range when it is full, then the GPU
  // conversion); the app's is its VideoFrame drawn 1:1 into a 2D canvas (the atlas's kind of draw).
  {
    const dir = path.join(WORK, 'f');
    const h = holder(dir, 9, 0, { DUMP_FRAMES: '20', DUMP_AFTER_MS: '3000' });
    await untilHolding(h);
    // The app dumps 20 frames from its 3rd second (~1.3 s); the engine's 12 (~0.8 s) start inside that.
    while ((h.read()?.t ?? 0) < 3200) await sleep(50);
    const r = await engine(0, null, ['--camera-dump', IDX, '12', path.join(dir, 'eng')]);
    await h.done;
    const app = [], eng = [];
    for (const f of fs.readdirSync(dir)) {
      let m;
      if ((m = /^f(\d+)\.json$/.exec(f))) app.push({ k: +m[1], ...JSON.parse(fs.readFileSync(path.join(dir, f))) });
      if ((m = /^eng\.f(\d+)\.json$/.exec(f))) eng.push({ k: +m[1], ...JSON.parse(fs.readFileSync(path.join(dir, f))) });
    }
    let pairs = 0, worst = 0, maxd = 0;
    for (const e of eng) {
      const er = fs.readFileSync(path.join(dir, `eng.f${e.k}.raw`));
      if (e.format !== 'NV12') continue;
      const yd = (x) => { const ap = fs.readFileSync(path.join(dir, `f${x.k}.planes.bin`)); let s = 0, n = 0;
        for (let y = 0; y < e.h; y += 4) for (let xx = 0; xx < e.w; xx += 4) { const ev = er[y * e.pitch + xx]; s += Math.abs(ap[y * x.layout[0].stride + xx] - (e.fullRange ? 16 + ev * 219 / 255 : ev)); n++; } return s / n; };
      const near = app.filter((x) => Math.abs(x.timestamp - e.ts100 / 10) < 150000 && x.display[0] === e.w && x.display[1] === e.h);
      if (!near.length) continue;
      // Only the app frame of the SAME image counts (mean |dY| ~0.24 measured; the neighbouring frames ~2): an
      // engine frame whose twin fell outside the app's dump window is skipped, not mis-paired.
      const best = near.map((x) => ({ x, yd: yd(x) })).sort((p, q) => p.yd - q.yd)[0];
      if (best.yd > 0.6) continue;
      const a = best.x;
      const out = path.join(dir, `eng.f${e.k}.rgba`);
      execFileSync(ENGINE, ['--camera-convert', path.join(dir, `eng.f${e.k}.json`), out]);
      const E = fs.readFileSync(out), A = fs.readFileSync(path.join(dir, `f${a.k}.rgba.bin`));
      let diff = 0, n = 0;
      for (let i = 0; i < E.length; i += 4) for (let c = 0; c < 3; c++) { const d = Math.abs(E[i + c] - A[i + c]); if (d) diff++; maxd = Math.max(maxd, d); n++; }
      worst = Math.max(worst, diff / n); pairs++;
      if (pairs === 1) console.log(`F engine ${e.format} ${e.w}x${e.h} ${e.bt709 ? 'BT.709' : 'BT.601'} ${e.fullRange ? 'FULL' : 'limited'} · app ${a.format} ${a.colorSpace.matrix} ${a.colorSpace.fullRange ? 'full' : 'limited'}`);
    }
    if (pairs < 8) {
      const at = app.map((x) => x.timestamp).sort((p, q) => p - q), et = eng.map((x) => x.ts100 / 10).sort((p, q) => p - q);
      console.log(`F diagnostics: app ${app.length} frames ${at.length ? `${(at[0] / 1e3).toFixed(0)}..${(at[at.length - 1] / 1e3).toFixed(0)} ms` : ''} ${app[0] ? `${app[0].display[0]}x${app[0].display[1]}` : ''}; engine ${eng.length} frames ${et.length ? `${(et[0] / 1e3).toFixed(0)}..${(et[et.length - 1] / 1e3).toFixed(0)} ms` : ''} ${eng[0] ? `${eng[0].format} ${eng[0].w}x${eng[0].h}` : ''}; ${r.out.trim().replace(/\r?\n/g, ' | ')}`);
    }
    console.log(`F ${pairs} frames paired; worst ${(100 * (1 - worst)).toFixed(3)}% of channels identical, max ${maxd}${/missed/.test(r.out) ? ' (the dump missed frames)' : ''}`);
    if (pairs < 8 || maxd > 1 || worst > 0.001) { console.log('FAIL F: the engine does not draw the camera as the app does (within 1 on at most 0.1%)'); fail++; }
    else console.log('PASS F: the camera picture is the app\'s, within 1 on at most 0.1% of channels');
  }
  // ── G: WHICH camera — the app's label (and picture) → the engine's camera ─────────────────────────────────
  // The fingerprint is the app's own code (src/renderer/engine/cameraFingerprint.ts, bundled into the page).
  {
    const dir = path.join(WORK, 'g');
    fs.mkdirSync(dir, { recursive: true });
    const lib = path.join(dir, 'fp.js');
    require(path.join(ROOT, 'node_modules', 'esbuild')).buildSync({ entryPoints: [path.join(ROOT, 'src', 'renderer', 'engine', 'cameraFingerprint.ts')], bundle: true, format: 'iife', globalName: 'camFp', platform: 'browser', outfile: lib, logLevel: 'error' });
    const h = holder(dir, 14, 0, { FP_LIB: lib });
    await untilHolding(h);
    while (!h.read()?.fp) await sleep(100);
    const st = h.read();
    const fpFile = path.join(dir, 'app-fp.json'), flipFile = path.join(dir, 'app-fp-flipped.json');
    // Each resolve gets the app's CURRENT fingerprint (the runtime will send a fresh one too).
    const fresh = () => { const f = h.read()?.fp ?? st.fp; fs.writeFileSync(fpFile, JSON.stringify(f)); fs.writeFileSync(flipFile, JSON.stringify([...f].reverse())); };
    const want = new RegExp(`^\\[${IDX}\\] .*  (\\S+)\\r?$`, 'm').exec(list)[1];
    const once = (args, env) => { fresh(); try { return execFileSync(ENGINE, ['--camera-resolve', ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim(); } catch (e) { return String(e.stdout || '').trim(); } };
    // A picture that does not settle it is REFUSED, not guessed (motion between the app's fingerprint and the
    // engine's read lowers the likeness): a case that should resolve tries up to 3 times, as the runtime will
    // retry. What must NEVER happen is resolving to the wrong camera.
    const resolve = (args, env = {}, tries = 1) => { let o = ''; for (let k = 0; k < tries; k++) { o = once(args, env); if (!/does not settle it/.test(o)) break; } return o; };
    const g = [
      ['label', resolve([st.label, fpFile]), (o) => o.startsWith(`RESOLVED ${want} `)],
      ['twin, same picture', resolve([st.label, fpFile], { ARTLUX_CAM_TWIN: 'same' }), (o) => o.startsWith('REFUSED') && /does not settle it/.test(o)],
      ['twin, other picture', resolve([st.label, fpFile], { ARTLUX_CAM_TWIN: 'flip' }, 3), (o) => o.startsWith(`RESOLVED ${want} `) && /by picture/.test(o)],
      ['twin, app picture flipped', resolve([st.label, flipFile], { ARTLUX_CAM_TWIN: 'flip' }, 3), (o) => o.startsWith(`RESOLVED twin:${want} `)],
      ['twin, no picture', resolve([st.label], { ARTLUX_CAM_TWIN: 'same' }), (o) => o.startsWith('REFUSED') && /picture is needed/.test(o)],
    ];
    // Every other camera Chromium lists that the engine cannot see (the PS3 Eye here: DirectShow only) is refused.
    for (const d of st.devices.filter((d) => d.label !== st.label)) {
      const o = resolve([d.label]);
      g.push([`"${d.label}"`, o, (x) => x.startsWith('REFUSED') || x.startsWith('RESOLVED')]);
    }
    await h.done;
    let bad = 0;
    for (const [what, out, ok] of g) { const pass = ok(out); if (!pass) bad++; console.log(`G ${pass ? 'ok  ' : 'BAD '} ${what}: ${out.replace(/\\\?\usb#/, 'usb#')}`); }
    if (bad) { console.log(`FAIL G: ${bad} identity case(s) wrong`); fail++; } else console.log('PASS G: the app camera is found by label, and by picture among identical ones (or refused)');
  }
  // ── C: nobody holds the camera ────────────────────────────────────────────────────────────────────────
  {
    const r = await engine(3, null);
    console.log(`C alone: ${r.out.split('\n').filter((l) => /SHARED: /.test(l)).join(' | ')}`);
  }
  console.log(fail ? `${fail} gate(s) FAILED` : 'camera-shared: PASS');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`FAIL: ${e.message}`); process.exit(1); });
