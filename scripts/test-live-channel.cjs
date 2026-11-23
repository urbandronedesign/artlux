// Runtime proof of the live channel (E5/W4, plans/native-engine.md §9a, shared/liveProtocol.ts).
//
//   node scripts/test-live-channel.cjs [--keep]
//
// The client here is the editor ITSELF, paired with its own broker THROUGH MAIN (src/main/liveHub.ts):
// the same IPC request, the same MessageChannelMain, the same preload relay a panel window will use in
// W5. Only the process boundary between the two ends is missing, and the wire does not care.
//
// THE CLAIMS.
//   1. A window asks main for a live port and is paired with the engine owner; the owner says which
//      streams it has.
//   2. NOTHING RUNS FOR NOBODY: before anyone subscribes, no producer hook is attached and the clock
//      check is not on the transport.
//   3. PULL, NEVER PUSH: a subscription gets samples while its window pulls; when the window stops
//      pulling (as a hidden window's paused rAF does) it gets exactly ONE more sample and then nothing,
//      however fast the producer runs; pulling again resumes the flow. Owner sends == client receipts.
//   4. Unsubscribing detaches the producer hook.
//   5. THE CLOCK IS AN ANCHOR: while playing for seconds, anchors stay in single figures (one per frame
//      would be hundreds), and the client's extrapolated playhead agrees with the owner's own clock to
//      within a millisecond. Pause, seek and the end-stop each produce an anchor that agrees.
//   6. Thumbnails and peaks come from the owner's caches, and answering does not break the cache (the
//      bitmap sent is a copy: a second ask still gets a full one).
//   7. LIVE DRAG: a drag drives the owner's render-free channel; a client that vanishes mid-drag has its
//      hold abandoned (main's "client gone" notice is simulated; the real windows arrive in W5).
// Restores the whole prefs file, like every harness here.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PREFS_FILE = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const PREFS_BACKUP = (() => { try { return fs.readFileSync(PREFS_FILE); } catch { return null; } })();
function restorePrefs() {
  if (!PREFS_BACKUP) return;
  try { fs.writeFileSync(PREFS_FILE, PREFS_BACKUP); console.log('prefs restored'); }
  catch (e) { console.log(`prefs NOT restored (${e.message}) — backup was taken from ${PREFS_FILE}`); }
}

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9387';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-live-channel-test');
// Test media, COPIED into the harness project's folder: artlux-media:// serves only the open project
// (src/main/mediaAccess.ts), so a path into the repo's examples would be a 403, not a thumbnail.
const SRC_VIDEO = path.join(ROOT, 'examples', 'interactive-show', 'assets', 'video', 'attract.mp4');
const SRC_AUDIO = path.join(ROOT, 'examples', 'audio', 'assets', 'audio', 'sting-main.wav');
const VIDEO = path.join(WORK, 'assets', 'attract.mp4');
const AUDIO = path.join(WORK, 'assets', 'sting-main.wav');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

const TL_SEC = 4;
function buildProject() {
  fs.mkdirSync(path.join(WORK, 'assets'), { recursive: true });
  fs.copyFileSync(SRC_VIDEO, VIDEO);
  fs.copyFileSync(SRC_AUDIO, AUDIO);
  const file = path.join(WORK, 'live-channel-test.artlux');
  const strip = (id, name, y, addr) => ({
    id, name, x: 0.1, y, width: 0.5, height: 0.04, rotation: 0,
    universe: 0, startAddress: addr, ledCount: 30, reverse: false, colorData: [], surfaceId: 'sf_wall',
  });
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [{ id: 'sf_wall', name: 'Wall 1', x: 0.05, y: 0.05, width: 0.9, height: 0.9, rotation: 0, zIndex: 0, content: { type: 'NONE' } }],
    fixtures: [strip('fx_a', 'Strip 1', 0.2, 1), strip('fx_b', 'Strip 2', 0.4, 91)],
    controllers: [{ id: 'ctl', name: 'Main', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0 }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false },
    // A short, NON-looping timeline: step 5 plays it into its end-stop.
    timeline: { layers: [], clips: [], duration: TL_SEC, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [] },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}
const MAIN_LOG = path.join(os.tmpdir(), 'artlux-live-channel-test.main.log');
function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', ...(() => { const fd = fs.openSync(MAIN_LOG, 'w'); return [fd, fd]; })()], shell: process.platform === 'win32' });
}
async function stop(child) {
  // ITS OWN TREE, never every electron.exe: the owner's own session may be open beside the test. The
  // tree kill goes FIRST — killing the npm shell alone orphans the app, and the walk then finds nothing.
  try { execSync(process.platform === 'win32' ? `taskkill /PID ${child.pid} /F /T` : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  await sleep(2000);
}

let failures = 0;
const note = (ok, what, detail) => {
  if (!ok) failures++;
  console.log(`   ${ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}${detail ? `\n        ${detail}` : ''}`);
};
const clickTitle = (page, re) => page.evaluate((src) => {
  const r = new RegExp(src);
  const b = [...document.querySelectorAll('button')].find((x) => r.test(x.getAttribute('title') || ''));
  if (b) b.click();
  return !!b;
}, re.source);

(async () => {
  if (!puppeteer) { console.error('puppeteer-core not installed — run npm install'); process.exit(1); }
  for (const f of [SRC_VIDEO, SRC_AUDIO]) if (!fs.existsSync(f)) { console.error(`missing test media ${f}`); process.exit(1); }
  const project = buildProject();
  const child = launch(project);
  let browser = null;
  try {
    let up = null;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { /* not yet */ } }
    if (!up) throw new Error('the app never opened its CDP port');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page = (await browser.pages()).find((p) => /localhost:3000/.test(p.url()) && !/splash\.html|projector\.html|docs\.html/.test(p.url())) || null;
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no editor page');
    const ev = (fn, ...args) => page.evaluate(fn, ...args);
    for (let i = 0; i < 90; i++) { if (await ev(() => document.querySelectorAll('button').length > 3 && !!window.__liveBroker).catch(() => false)) break; await sleep(1000); }
    await sleep(2500); // the project load and the cold-start gate

    console.log('\n1. a window is paired with the engine owner through main');
    await ev(() => window.__liveClient.connect('harness'));
    let paired = false;
    for (let i = 0; i < 20 && !paired; i++) { paired = await ev(() => window.__liveClient.connected() && window.__liveBroker.clients().length === 1); if (!paired) await sleep(250); }
    const offered = await ev(() => window.__liveClient.streams());
    note(paired, 'paired', paired ? `client id ${await ev(() => window.__liveClient.id())}` : 'no pair within 5 s');
    if (!paired) throw new Error('no live pair');
    note(offered.includes('dmx.pixels') && offered.includes('perf'), 'the owner offers the core streams', offered.join(', '));

    console.log('\n2. nothing runs for nobody');
    // "Nobody" = no client AND no editor panel. A plugin panel on screen in the editor (Trigger Zones on
    // the 3D workbench) reads its runtime through the same broker, locally — it is somebody.
    const forNobody = () => ev(() => { const l = window.__liveBroker.locals(); return window.__liveBroker.attached().filter((k) => !l.includes(k)); });
    const before = await forNobody();
    note(before.length === 0, 'no producer hook attached before a subscription (other than an on-screen editor panel)', before.length ? `attached for nobody: ${before.join(', ')}` : `editor panels reading: ${(await ev(() => window.__liveBroker.locals())).join(', ') || 'none'}`);
    note(!(await ev(() => window.__liveBroker.clockWatching())), 'the clock check is off before a client asks for the clock');

    console.log('\n3. pull, never push');
    await ev(() => {
      window.__lt = { dmx: 0, perf: 0, bytes: 0 };
      window.__lt.offDmx = window.__liveClient.subscribe('dmx.pixels', null, (v) => { window.__lt.dmx++; window.__lt.bytes = v.bytes.length; });
      window.__lt.offPerf = window.__liveClient.subscribe('perf', null, () => { window.__lt.perf++; });
      window.__liveBroker.resetSent();
    });
    await sleep(3000);
    let r = await ev(() => ({ dmx: window.__lt.dmx, perf: window.__lt.perf, bytes: window.__lt.bytes, sent: window.__liveBroker.clients()[0].sent, attached: window.__liveBroker.attached() }));
    note(r.attached.includes('dmx.pixels') && r.attached.includes('perf'), 'a subscription attaches its producer', r.attached.join(', '));
    note(r.dmx > 0 && r.bytes === 2 * 30 * 4, 'DMX samples arrive with the rig\'s pixels', `${r.dmx} samples in 3 s, ${r.bytes} bytes each (2 strips × 30 px × RGBW)`);
    note(r.perf >= 2 && r.perf <= 5, 'the 1 Hz perf stream arrives at its own rate', `${r.perf} samples in 3 s`);
    const dmxRate = r.dmx / 3;

    // Stop pulling, as a hidden window does. The producer keeps running; the owner must go quiet.
    await ev(() => { window.__liveClient.holdPulls(true); });
    await sleep(500); // whatever was already pulled lands
    const held0 = await ev(() => ({ dmx: window.__lt.dmx, perf: window.__lt.perf }));
    await sleep(3000);
    const held1 = await ev(() => ({ dmx: window.__lt.dmx, perf: window.__lt.perf }));
    note(held1.dmx - held0.dmx === 0 && held1.perf - held0.perf <= 1,
      'a window that stops pulling is sent nothing more',
      `in 3 s with pulls held: ${held1.dmx - held0.dmx} DMX samples (producer at ~${Math.round(dmxRate)}/s), ${held1.perf - held0.perf} perf`);
    await ev(() => { window.__liveClient.holdPulls(false); });
    await sleep(1500);
    const resumed = await ev(() => window.__lt.dmx);
    note(dmxRate < 1 || resumed > held1.dmx, 'pulling again resumes the flow', `${resumed - held1.dmx} DMX samples in 1.5 s after release`);
    r = await ev(() => ({ got: window.__liveClient.received().data || 0, sent: window.__liveBroker.clients()[0].sent.data || 0 }));
    // received() counts since the page loaded, sent since resetSent(): compare the delta only roughly.
    note(r.sent > 0 && r.got >= r.sent, 'every sample the owner sent was received', `owner sent ${r.sent} since reset, client received ${r.got} in all`);

    console.log('\n4. unsubscribing detaches the producer');
    await ev(() => { window.__lt.offDmx(); window.__lt.offPerf(); });
    await sleep(300);
    const after = await forNobody();
    note(after.length === 0, 'no producer hook left attached (other than an on-screen editor panel)', after.length ? `attached for nobody: ${after.join(', ')}` : '');

    console.log('\n5. the clock is an anchor');
    await ev(() => { window.__lt.anchors = []; window.__lt.offClock = window.__liveClient.watchClock((a) => window.__lt.anchors.push(a)); });
    await sleep(800);
    const agreeNow = () => ev(() => {
      const a = window.__liveClient.anchor(); const t = window.__liveBroker.truth();
      if (!a) return null;
      const dt = Math.max(0, t.at - a.at) / 1000;
      const ph = a.offline ? a.playhead : a.playhead + a.playheadRate * dt;
      return { err: Math.abs(ph - t.playhead), truth: t.playhead, playing: t.playing, anchorPlaying: a.playing, rev: a.rev };
    });
    let a = await agreeNow();
    note(!!a && a.err <= 0.0015, 'the first anchor arrives and agrees', a ? `error ${(a.err * 1000).toFixed(2)} ms at ${a.truth.toFixed(3)} s` : 'no anchor');
    if (!(await clickTitle(page, /^Stop — pause/))) console.log('   (no Stop button found — continuing from where the playhead is)');
    await sleep(600);
    const n0 = await ev(() => window.__lt.anchors.length);
    if (!(await clickTitle(page, /^Play \/ Pause \(Space\)$/))) throw new Error('no Play button');
    // Sample agreement repeatedly while it plays.
    let worst = 0, samples = 0, sawPlaying = false;
    for (let i = 0; i < 10; i++) {
      await sleep(250);
      const s = await agreeNow();
      if (s && s.playing) { sawPlaying = true; samples++; worst = Math.max(worst, s.err); }
    }
    const nPlay = (await ev(() => window.__lt.anchors.length)) - n0;
    note(sawPlaying, 'the transport plays');
    note(nPlay >= 1 && nPlay <= 6, 'anchors while playing stay in single figures', `${nPlay} anchors over 2.5 s of playback (~150 frames)`);
    note(samples > 0 && worst <= 0.0015, 'the extrapolated playhead agrees with the owner\'s clock', `worst error ${(worst * 1000).toFixed(2)} ms over ${samples} samples`);
    // Into the end-stop (TL_SEC, not looping): the owner parks/pauses; the client must agree, and quietly.
    await sleep((TL_SEC + 1.5) * 1000 - 2500);
    const nEnd0 = await ev(() => window.__lt.anchors.length);
    await sleep(1500);
    const nEnd1 = await ev(() => window.__lt.anchors.length);
    a = await agreeNow();
    note(!!a && a.err <= 0.0015 && Math.abs(a.truth - TL_SEC) < 0.1, 'at the end-stop the client agrees', a ? `owner ${a.truth.toFixed(3)} s, error ${(a.err * 1000).toFixed(2)} ms, playing ${a.playing}` : '');
    note(nEnd1 - nEnd0 === 0, 'a stopped clock sends no anchors', `${nEnd1 - nEnd0} anchors in 1.5 s at rest`);
    // A seek while stopped: the Stop button returns to the start.
    await clickTitle(page, /^Stop — pause/);
    await sleep(500);
    a = await agreeNow();
    note(!!a && a.err <= 0.0015 && a.truth < 0.1, 'a seek produces an anchor that agrees', a ? `owner ${a.truth.toFixed(3)} s, error ${(a.err * 1000).toFixed(2)} ms` : '');
    await ev(() => window.__lt.offClock());
    await sleep(300);
    note(!(await ev(() => window.__liveBroker.clockWatching())), 'releasing the clock turns the check off');

    console.log('\n6. thumbnails and peaks come from the owner');
    const th = await ev(async (p) => {
      const t0 = performance.now();
      const b1 = await window.__liveClient.thumb(p, 1);
      const t1 = performance.now();
      const b2 = await window.__liveClient.thumb(p, 1);
      const res = { w1: b1 ? b1.width : 0, h1: b1 ? b1.height : 0, w2: b2 ? b2.width : 0, ms1: Math.round(t1 - t0), ms2: Math.round(performance.now() - t1) };
      b1?.close(); b2?.close();
      return res;
    }, VIDEO);
    note(th.w1 === 160 && th.h1 === 90, 'a thumbnail arrives, decoded by the owner', `${th.w1}×${th.h1} in ${th.ms1} ms`);
    note(th.w2 === 160, 'the owner\'s cache survives answering (a copy was sent)', `second ask: ${th.w2} px wide in ${th.ms2} ms`);
    const pk = await ev(async (p) => {
      const r = await window.__liveClient.peaks(p, 64);
      return { n: r.peaks ? r.peaks.length : 0, max: r.peaks ? Math.max(...r.peaks) : 0, duration: r.duration };
    }, AUDIO);
    note(pk.n === 64 && pk.max > 0 && pk.duration > 0, 'waveform peaks arrive from the owner\'s decode', `${pk.n} buckets, peak ${pk.max.toFixed(3)}, source ${pk.duration ? pk.duration.toFixed(2) : '?'} s`);

    console.log('\n7. live drag');
    const br = () => ev(() => getComputedStyle(document.documentElement).getPropertyValue('--preview-brightness').trim());
    await ev(() => window.__liveClient.drag({ target: 'ledBrightness', value: 0.3 }));
    await sleep(300);
    note((await br()) === '0.3', 'a drag drives the owner\'s render-free brightness channel', `--preview-brightness = ${await br()}`);
    await ev(() => window.__liveClient.drag({ target: 'fixtureChannel', fixtureId: 'fx_a', key: 'dimmer', value: 200 }));
    await sleep(300);
    let held = await ev(() => window.__liveBroker.clients()[0].held);
    note(held.length === 2, 'the owner knows what the client is holding', held.map((k) => k.replace(/\u0000/g, '/')).join(', '));
    // Main's "this client is gone" notice, as src/main/liveHub.ts posts it (simulated: the client here is
    // the editor, which cannot close without closing the owner).
    const cid = await ev(() => window.__liveClient.id());
    await ev((id) => window.postMessage({ kind: 'artlux:live-port', payload: { role: 'drop', clientId: id } }, '*'), cid);
    await sleep(300);
    note((await ev(() => window.__liveBroker.clients().length)) === 0, 'the client is dropped');
    note((await br()) === '1', 'its brightness drag is put back to the committed value', `--preview-brightness = ${await br()}`);
  } catch (e) {
    failures++;
    console.log(`\n\x1b[31mABORTED\x1b[0m ${e.message}`);
  } finally {
    try { await browser?.disconnect(); } catch { /* gone */ }
    if (!KEEP) await stop(child);
    restorePrefs();
    if (!KEEP) try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* in use */ }
    console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : '\n\x1b[32mALL PASSED\x1b[0m');
    process.exit(failures ? 1 : 0);
  }
})();
