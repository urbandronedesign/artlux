#!/usr/bin/env node
// E6a — A BAKE DRAWN AND ENCODED BY THE NATIVE ENGINE (plans/native-engine.md §9, E6: "bake via the engine").
//
//   node scripts/test-engine-bake.cjs --packaged <ArtLux.exe> --mp4 <film.mp4> [--width W --height H --fps F] [--keep]
//
// The packaged app with `--native-engine`, on a SCRATCH profile (own processes only), a REAL film on a timeline track
// (the owner's rule for video tests: a Full HD or 4K film already on the machine), an effect surface and a bed of
// sound. Through the bake's own entry (`window.__artluxBake`, the panel's request) it renders:
//   1. the film's track via the ENGINE (the default when the engine draws the content) — and again via the APP;
//   2. the effect surface both ways;
//   3. the film with its sound, via the engine.
// Then the engine's own decoder holds every baked frame against the SOURCE FILM (`--mp4-compare`): the frame at
// each time must be the film's frame at that time — not its neighbour — within an encode's error. Gates:
//   · the bake says the engine drew it, and names the encoder (the GPU's own where there is one);
//   · frame count, no frame early or late against the film, luma within 3 levels on average and 8 at worst;
//   · the app's bake of the same range: the same frames (it is the comparison, not a gate on the engine);
//   · the effect: the engine's frames against the app's, within the effect parity's own tolerance;
//   · with sound: an AAC track, and exactly range × 48000 samples handed to the encoder.
const { spawn, execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const http = require('node:http');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const EXE = arg('--packaged') && path.resolve(arg('--packaged'));
const FILM = arg('--mp4') ? path.resolve(arg('--mp4')) : process.env.ARTLUX_MP4;
if (!EXE || !FILM || !fs.existsSync(FILM)) { console.error('usage: node scripts/test-engine-bake.cjs --packaged <ArtLux.exe> --mp4 <film.mp4>  (a Full HD or 4K H.264 film, 6 s or more)'); process.exit(2); }
const ENGINE = path.join(path.dirname(EXE), 'resources', 'engine', 'artlux-engine.exe');
const TONE = path.join(ROOT, 'native', 'audio-engine', 'tone-100.wav');
const KEEP = process.argv.includes('--keep');
const CDP_PORT = '9379';
const WORK = path.join(os.tmpdir(), 'artlux-engine-bake');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));

function buildProject() {
  const file = path.join(WORK, 'engine-bake.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [
      { id: 'sM', name: 'Film', x: 0.02, y: 0.02, width: 0.96, height: 0.54, rotation: 0, zIndex: 0, content: { type: 'LAYER', layerId: 'LM', opacity: 1 } },
      { id: 'sE', name: 'Effect', x: 0.02, y: 0.6, width: 0.5, height: 0.3, rotation: 0, zIndex: 1, content: { type: 'EFFECT', effectId: 1, paletteId: 0, speed: 0.5, intensity: 0.8, opacity: 1 } },
    ],
    fixtures: [], controllers: [], groups: [], scenes: [], cueBanks: [],
    timeline: { duration: 10, fps: 25, loop: false, layers: [{ id: 'LM', name: 'Film', opacity: 1 }], clips: [{ id: 'cM', layerId: 'LM', name: 'film', path: FILM, start: 0, duration: 10, inPoint: 0 }], markers: [], inPoint: null, outPoint: null },
    audio: { tracks: [{ id: 'atr', name: 'Bed', gain: 0.5, mute: false }], clips: [{ id: 'acl', trackId: 'atr', name: 'tone', path: TONE, start: 0, duration: 10, inPoint: 0, sourceDuration: 3, gain: 1, mute: false }], buses: [] },
    stateMachine: { enabled: false, states: [], transitions: [], regions: [] },
  }, null, 2));
  return file;
}

(async () => {
  for (let i = 0; ; i++) { try { fs.rmSync(WORK, { recursive: true, force: true }); break; } catch (e) { if (i >= 20) throw e; await sleep(500); } }
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: false } }));
  const project = buildProject();
  const logf = path.join(WORK, 'app.log');
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT, ARTLUX_ENGINE_DOC_DUMP: path.join(WORK, 'doc.json') }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--native-engine', `--project=${project}`], { env, stdio: ['ignore', log, log] });
  let failed = 0;
  const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
  let browser = null;
  const results = {};
  try {
    let ver = null;
    for (let i = 0; i < 90 && !ver; i++) { try { ver = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { await sleep(1000); } }
    if (!ver) throw new Error('no CDP endpoint');
    browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null, protocolTimeout: 900_000 });
    let page = null;
    for (let i = 0; i < 60 && !page; i++) { page = (await browser.pages()).find((p) => /index\.html/.test(p.url())) ?? null; if (!page) await sleep(1000); }
    if (!page) throw new Error('no editor page');
    const con = fs.openSync(path.join(WORK, 'renderer.log'), 'w');
    page.on('console', (m) => { try { fs.writeSync(con, `${m.type()} ${m.text()}
`); } catch { /* closed */ } });
    for (let i = 0; i < 60; i++) { if (await page.evaluate(() => typeof window.__artluxBake === 'function')) break; await sleep(1000); }
    for (let i = 0; i < 60; i++) { if (/\[engine\] up \(pid/.test(fs.readFileSync(logf, 'utf8'))) break; await sleep(1000); }
    await sleep(8000);   // the film's decoders, the document, the engine's verdict
    const bake = (req) => page.evaluate((r) => window.__artluxBake(r), req);
    const base = { startSec: 0, endSec: 4, fps: Number(arg('--fps') ?? 25), clock: 'playhead', bitrate: 16_000_000, audio: false, alpha: false };
    // The film's native size and rate (the bake is made at both): --width/--height, Full HD by default; 25 fps.
    const W = Number(arg('--width') ?? 1920), H = Number(arg('--height') ?? 1080);
    // The bakes, in this order; `--only a,b` runs just those, in the order given (a debugging aid).
    const all = {
      engine: () => bake({ ...base, surfaceId: 'sM', width: W, height: H, outPath: path.join(WORK, 'film-engine.mp4') }),
      app: () => bake({ ...base, surfaceId: 'sM', width: W, height: H, via: 'app', outPath: path.join(WORK, 'film-app.mp4') }),
      fxEngine: () => bake({ ...base, clock: 'show', surfaceId: 'sE', width: 640, height: 360, outPath: path.join(WORK, 'fx-engine.mp4') }),
      fxApp: () => bake({ ...base, clock: 'show', surfaceId: 'sE', width: 640, height: 360, via: 'app', outPath: path.join(WORK, 'fx-app.mp4') }),
      sound: () => bake({ ...base, surfaceId: 'sM', width: W, height: H, audio: true, endSec: 2, outPath: path.join(WORK, 'film-sound.mp4') }),
      // The film's surface AGAIN, once its first bake is bound: the render must draw the content, not that file.
      rebake: () => bake({ ...base, surfaceId: 'sM', width: W, height: H, outPath: path.join(WORK, 'film-rebake.mp4') }),
      soundApp: () => bake({ ...base, surfaceId: 'sM', width: W, height: H, audio: true, endSec: 2, via: 'app', outPath: path.join(WORK, 'film-sound-app.mp4') }),
    };
    // The sound bake before the effect bakes: the bed rides the SHOW clock, which a playhead bake does not step, and
    // a show-clock bake leaves it at its range's end — past the 3 s tone's source.
    const order = arg('--only') ? arg('--only').split(',') : ['engine', 'app', 'sound', 'fxEngine', 'fxApp', 'rebake'];
    for (const k of order) results[k] = await all[k]();
  } catch (e) {
    check('the run', false, e.message);
  } finally {
    try { browser?.disconnect(); } catch { /* gone */ }
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  }
  const lines = fs.readFileSync(logf, 'utf8').split(/\r?\n/);
  for (const [k, r] of Object.entries(results)) console.log(`   ${k}: ${JSON.stringify(r)}`);
  const e = results.engine ?? {}, a = results.app ?? {};
  check('the film bake was drawn by the engine', e.kind === 'ok' && e.drawnBy === 'engine', e.reason ?? e.encoder);
  check('the engine names its encoder', !!e.encoder, e.encoder);
  check('the app bake of the same range was the app\'s', a.kind === 'ok' && a.drawnBy === 'app', a.reason);
  const cmp = (f, ref = FILM) => { const r = spawnSync(ENGINE, ['--mp4-compare', f, ref], { encoding: 'utf8' }); try { return JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { return { ok: false, error: r.stderr }; } };
  if (e.kind === 'ok') {
    const c = cmp(e.path);
    check('the engine\'s bake has every frame of the range', c.ok && c.frames === 100, `${c.frames} frames${c.error ? ' — ' + c.error : ''}`);
    check('no frame of the engine\'s bake is early or late against the film', c.ok && c.off === 0, `${c.off} off ${JSON.stringify(c.offFrames ?? [])}`);
    check('the engine\'s frames are the film\'s within an encode\'s error', c.ok && c.meanLuma < 3 && c.worstLuma < 8, `luma ${(+c.meanLuma).toFixed(2)} mean, ${(+c.worstLuma).toFixed(2)} worst; chroma ${(+c.worstChroma).toFixed(2)} worst`);
    const s = lines.find((l) => /artlux-engine: bake: \d+ frame\(s\).* written to .*film-engine/.test(l));
    check('the engine logged what the bake cost', !!s, s?.replace(/^.*bake: /, ''));
  }
  if (a.kind === 'ok') {
    const c = cmp(a.path);
    console.log(`   (the app's bake against the film: ${c.frames} frames, ${c.off} off, luma ${(+c.meanLuma).toFixed(2)} mean / ${(+c.worstLuma).toFixed(2)} worst, chroma ${(+c.worstChroma).toFixed(2)} worst)`);
    if (e.kind === 'ok') console.log(`   render time: engine ${e.elapsedMs} ms, app ${a.elapsedMs} ms for ${e.frames} frames`);
  }
  const fe = results.fxEngine ?? {}, fa = results.fxApp ?? {};
  check('the effect bake was drawn by the engine', fe.kind === 'ok' && fe.drawnBy === 'engine', fe.reason);
  if (fe.kind === 'ok' && fa.kind === 'ok') {
    const c = cmp(fe.path, fa.path);
    check('the effect: the engine\'s frames are the app\'s', c.ok && c.frames === 100 && c.off === 0 && c.meanLuma < 4, `${c.frames} frames, ${c.off} off, luma ${(+c.meanLuma).toFixed(2)} mean / ${(+c.worstLuma).toFixed(2)} worst`);
  }
  const so = results.sound ?? {};
  check('the bake with sound was drawn by the engine', so.kind === 'ok' && so.drawnBy === 'engine', so.reason ?? so.audioNote);
  if (so.kind === 'ok') {
    const bytes = fs.readFileSync(so.path);
    check('the file carries an AAC track', bytes.includes(Buffer.from('mp4a')));
    const s = lines.find((l) => /artlux-engine: bake: \d+ frame\(s\) \+ (\d+) sample\(s\) of sound written to .*film-sound/.test(l));
    const n = s && +/\+ (\d+) sample/.exec(s)[1];
    check('every sample of the range reached the encoder', n === 2 * 48000, `${n} samples (${2 * 48000} expected)`);
    check('the sound was not silent', !so.audioNote, so.audioNote ?? '');
  }
  const rb = results.rebake;
  if (rb) {
    check('a surface already bound to its bake is re-baked by the engine', rb.kind === 'ok' && rb.drawnBy === 'engine', rb.reason);
    if (rb.kind === 'ok') {
      const c = cmp(rb.path);
      const blank = lines.find((l) => /film-rebake.*frame\(s\) the surface drew nothing/.test(l));
      check('the re-bake drew the content (the film), not its own previous file', c.ok && c.off === 0 && c.meanLuma < 3 && !blank, `${c.off} off, luma ${(+c.meanLuma).toFixed(2)} mean${blank ? '; black frames: ' + blank.replace(/^.*; /, '') : ''}`);
    }
  }
  if (!KEEP && !failed) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* the profile may still be locked */ } }
  else console.log(`   (kept: ${WORK})`);
  console.log(failed ? `\nengine bake: ${failed} FAILED` : '\nengine bake OK');
  process.exit(failed ? 1 : 0);
})();
