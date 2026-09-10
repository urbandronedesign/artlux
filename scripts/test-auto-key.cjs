// Runtime proof that ARMING auto-key turns the channel strip into an authoring surface: release a
// fader and a keyframe lands on the timeline, on the lane for that fixture's channel.
//
//   node scripts/test-auto-key.cjs [--keep]
//
// The gesture an operator already uses to make a light look right is the one that should record the
// look. Before this, a fader release wrote only `Fixture.dmx` — a static value the timeline never saw
// — so authoring a move meant leaving the fixture, opening a target picker, finding the parameter by
// name and placing keys by hand against an axis.
//
// `npm run verify` reads source: it can assert the call is spelled, never that a real drag on a real
// fader lands a real key. This drives the shell.
//
// Three things, in the order they matter:
//   1. NOT ARMED, a fader move records NOTHING. Half of what a fader is for is looking — sweeping the
//      pan to find the wall, running the dimmer up to see where the beam lands. Recording that would
//      fill a show with keys nobody meant, so this is the assertion that keeps the feature honest.
//   2. ARMED, a release creates the lane and puts ONE key on it.
//   3. A SECOND release at the same playhead REPLACES that key rather than stacking a second one at
//      the same instant — the sampler walks a sorted array, and two keys at one `t` make the later
//      one win invisibly.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9378';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-auto-key-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

const PATH_DIMMER = 'fixtures.fx_head.dmx.dimmer';

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'auto-key-test.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [],
    fixtures: [{
      id: 'fx_head', name: 'Head 1', x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0,
      universe: 0, startAddress: 1, ledCount: 1, reverse: false, colorData: [],
      profileId: 'martin/mac-250-beam', profileMode: '16bt',
      dmx: { 'shutter-strobe': 35 / 255, dimmer: 0.2, pan: 0.5, tilt: 0.5 },
      position3D: { x: 0, y: 4, z: 0 }, controllerId: 'ctl',
    }],
    controllers: [{ id: 'ctl', name: 'DMX', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50 },
    // NO automation at all: the point is that arming a fader CREATES the lane.
    timeline: {
      layers: [], clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null,
      loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [],
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;   // inheriting it boots Electron as plain Node (DEVELOPMENT.md)
  env.ARTLUX_CDP_PORT = CDP_PORT;
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}

async function stop(child) {
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  try { execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(2000);
}

let failures = 0;
const note = (ok, what, detail) => {
  if (!ok) failures++;
  console.log(`   ${ok ? '\x1b[32mOK\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${what}${detail ? `\n        ${detail}` : ''}`);
};

const clickRail = (page, short) => page.evaluate((s) => {
  const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === s);
  if (b) b.click();
  return !!b;
}, short);

const selectFixture = (page, name) => page.evaluate((n) => {
  const row = [...document.querySelectorAll('div[role="button"]')].find((d) => (d.textContent || '').trim() === n);
  if (!row) return false;
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return true;
}, name);

/** A REAL mouse drag across a labelled fader — the gesture the whole feature depends on. */
async function dragSlider(page, label, from, to, ms) {
  const b = await page.evaluate((l) => {
    const el = [...document.querySelectorAll('input[type=range]')].find((i) => {
      const lab = document.querySelector(`label[for="${CSS.escape(i.id)}"]`);
      return lab && lab.textContent.trim() === l;
    });
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, label);
  if (!b) throw new Error(`no "${label}" fader in the channel strip`);
  const y = b.y + b.h / 2;
  const xAt = (f) => b.x + 8 + (b.w - 16) * f;
  const steps = Math.max(2, Math.round(ms / 25));
  await page.mouse.move(xAt(from), y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(xAt(from + (to - from) * (i / steps)), y); await sleep(25); }
  await page.mouse.up();
  await sleep(500);
}

/** How many lanes drive `path`, and how many keys the first of them holds. */
const laneState = (page, targetPath) => page.evaluate((p) => {
  const labels = [...document.querySelectorAll('[title]')].filter((e) => e.getAttribute('title') === p);
  const lane = labels.length ? labels[0].closest('.flex.border-b') : null;
  return {
    lanes: labels.length,
    keys: lane ? lane.querySelectorAll('.absolute.group').length : 0,
    // The key TIMES, read off the diamonds' own titles ("<value> @ <t>s · <curve>"). Whether a second
    // release replaces or adds depends entirely on whether the playhead moved, so the test has to see
    // the times rather than assume the transport was stopped.
    times: lane ? [...lane.querySelectorAll('[title]')].map((e) => e.getAttribute('title'))
      .filter((t) => /@/.test(t)).map((t) => t.split('@')[1].trim().split(' ')[0]) : [],
  };
}, targetPath);

(async () => {
  if (!puppeteer) { console.error('puppeteer-core not installed — run npm install'); process.exit(1); }
  const project = buildProject();
  const child = launch(project);
  let browser = null;
  try {
    let up = null;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { /* not yet */ } }
    if (!up) throw new Error('the app never opened its CDP port');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });

    // Identify the editor by ELIMINATION: in dev it is served at http://localhost:3000/ with no
    // filename in the URL, so an "index.html" matcher finds nothing.
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page = (await browser.pages()).find((p) => !/splash\.html|projector\.html|docs\.html/.test(p.url())) || null;
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no editor page');
    // The shell is not in the DOM for ~9 s after the page exists. Wait for the UI, not the document.
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => document.querySelectorAll('button').length > 0)) break;
      await sleep(1000);
    }

    // The layout is banked per workspace and the app opens into whichever one was last saved, so the
    // channel strip is not necessarily on screen. Go to the rig workbench and select the head.
    await clickRail(page, '3D');
    await sleep(1200);
    if (!(await selectFixture(page, 'Head 1'))) throw new Error('could not select Head 1 in the browser');
    await sleep(1000);
    // The timeline is a DRAWER — open it, or there are no lanes in the DOM to count.
    for (let i = 0; i < 4; i++) {
      if (await page.evaluate(() => !!document.querySelector('[title^="fixtures."], [title*="Automation"]'))) break;
      await page.keyboard.down('Control'); await page.keyboard.press('KeyT'); await page.keyboard.up('Control');
      await sleep(1200);
    }

    const armBtn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Record fader moves as keyframes|Recording — a fader/.test(x.textContent || ''));
      return b ? (b.textContent || '').trim() : null;
    });
    note(!!armBtn, 'the channel strip offers the arm, next to the faders', armBtn ? `reads "${armBtn}"` : 'no arm control found — is a light selected?');
    if (!armBtn) throw new Error('no arm control');

    // ── 1. NOT ARMED — a fader move must record nothing ──────────────────────────────────────────
    console.log('\n1. a fader move while NOT armed');
    await dragSlider(page, 'Dimmer', 0.2, 0.6, 400);
    let st = await laneState(page, PATH_DIMMER);
    note(st.lanes === 0, 'moving a fader while disarmed records NOTHING',
      `lanes driving ${PATH_DIMMER}: ${st.lanes} (expected 0 — looking at a rig is not authoring it)`);

    // ── 2. ARMED — the release creates the lane and lands one key ────────────────────────────────
    console.log('\n2. arm, then move the same fader');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Record fader moves as keyframes/.test(x.textContent || ''));
      if (b) b.click();
    });
    await sleep(400);
    const armedNow = await page.evaluate(() => !![...document.querySelectorAll('button')].find((x) => /Recording — a fader/.test(x.textContent || '')));
    note(armedNow, 'the arm reports itself as recording');

    await dragSlider(page, 'Dimmer', 0.6, 0.85, 400);
    st = await laneState(page, PATH_DIMMER);
    note(st.lanes === 1, 'releasing an armed fader CREATES the lane for that channel',
      `lanes driving ${PATH_DIMMER}: ${st.lanes}`);
    note(st.keys === 1, 'and lands exactly one keyframe on it', `keyframes: ${st.keys}`);

    // ── 3. A second release at the same playhead replaces, never stacks ──────────────────────────
    console.log('\n3. a second move, with the playhead where it was');
    await dragSlider(page, 'Dimmer', 0.85, 0.35, 400);
    st = await laneState(page, PATH_DIMMER);
    // If the transport is running, the playhead moved between the two releases and TWO keys is the
    // correct answer — that is a recording, not a duplicate. The replace rule only claims something
    // about two releases at the SAME instant, so read the times and judge accordingly.
    const moved = st.times.length > 1 && st.times[0] !== st.times[1];
    note(moved ? st.keys === 2 : st.keys === 1,
      moved ? 'the playhead moved between releases, so the second key is a second POINT'
            : 'a second release at the same instant REPLACES the key',
      `lanes ${st.lanes}, keyframes ${st.keys}, at t = ${st.times.join(' / ')}`);
  } catch (e) {
    failures++;
    console.error('\n   \x1b[31mERROR\x1b[0m', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }

  console.log(failures
    ? `\n\x1b[31mauto-key: ${failures} failure(s)\x1b[0m`
    : '\n\x1b[32mauto-key OK — an armed fader authors, a disarmed one only looks\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
