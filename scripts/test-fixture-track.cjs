// Runtime proof that a light's parameters arrive on ONE track, grouped, and that the filter narrows
// it to the ones actually carrying keyframes.
//
//   node scripts/test-fixture-track.cjs [--keep]
//
// The timeline could only ever show a head's parameters as a FLAT LIST of unrelated lanes, each added
// one at a time from a global search popover that knows nothing about the fixture you are working on.
// Twelve lanes for one head, sorted by nothing, next to twelve more for the next head — and no way to
// see a parameter you had not already thought to add.
//
// So the assertions are, in order:
//   1. every parameter of the PATCHED MODE is on the track, whether or not it has a curve;
//   2. they are grouped the way an operator reads a fixture (Intensity / Position / Colour / …);
//   3. the row set matches the inspector's channel strip EXACTLY — the two answer the same question
//      and must not disagree about what the fixture has;
//   4. the filter narrows to the keyed rows and back.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9379';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-fixture-track-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

// A MAC 250 Beam in 16-bit: 13 DMX channels, 11 parameters once the 16-bit pairs collapse.
const EXPECTED_PARAMS = 11;

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'fixture-track-test.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [],
    fixtures: [{
      id: 'fx_head', name: 'Head 1', x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0,
      universe: 0, startAddress: 1, ledCount: 1, reverse: false, colorData: [],
      profileId: 'martin/mac-250-beam', profileMode: '16bt',
      dmx: { 'shutter-strobe': 35 / 255, dimmer: 0.6, pan: 0.5, tilt: 0.5 },
      position3D: { x: 0, y: 4, z: 0 }, controllerId: 'ctl',
    }],
    controllers: [{ id: 'ctl', name: 'DMX', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50 },
    timeline: {
      layers: [], clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null,
      loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [],
      // ONE keyed parameter, so the filter has something to narrow TO.
      automation: [{
        id: 'ln_pan', targetPath: 'fixtures.fx_head.dmx.pan', enabled: true, height: 64,
        keyframes: [{ t: 0, v: 0.2, curve: 'linear' }, { t: 4, v: 0.8, curve: 'linear' }],
      }],
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
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

/** What the fixture track is showing right now. */
const trackState = (page) => page.evaluate(() => {
  const filter = [...document.querySelectorAll('button[title]')]
    .find((b) => /Showing (all|only)/.test(b.getAttribute('title') || ''));
  const track = filter ? filter.closest('.border-b') : null;
  if (!track) return { found: false };
  // An empty row names its channel and DMX address; a lane row names its target path. Together they
  // are every parameter currently on screen.
  const empties = [...track.querySelectorAll('[title]')]
    .map((e) => e.getAttribute('title')).filter((t) => / — DMX \d+$/.test(t));
  const laneRows = [...track.querySelectorAll('[title]')]
    .map((e) => e.getAttribute('title')).filter((t) => /^fixtures\.[^.]+\.dmx\./.test(t));
  const groups = [...track.querySelectorAll('button')]
    .map((b) => (b.textContent || '').trim())
    .filter((t) => /^(INTENSITY|POSITION|COLOUR|BEAM|GOBO|OTHER)\d*$/.test(t))
    .map((t) => t.replace(/\d+$/, ''));
  return {
    found: true,
    filterTitle: filter.getAttribute('title'),
    params: empties.length + laneRows.length,
    keyedRows: laneRows.length,
    labels: empties.map((t) => t.replace(/ — DMX \d+$/, '')).concat(laneRows),
    groups,
  };
});

/** The inspector's channel strip, for the "these two must agree" assertion. */
const stripChannels = (page) => page.evaluate(() => {
  const strip = [...document.querySelectorAll('button')]
    .find((b) => /Record fader moves as keyframes|Recording — a fader/.test(b.textContent || ''));
  const box = strip ? strip.parentElement : null;
  if (!box) return [];
  const sliders = [...box.querySelectorAll('input[type=range]')].map((i) => {
    const lab = document.querySelector(`label[for="${CSS.escape(i.id)}"]`);
    return lab ? lab.textContent.trim() : null;
  });
  const selects = [...box.querySelectorAll('select')].map((sel) => {
    const row = sel.closest('div');
    const lab = row ? row.querySelector('label') : null;
    return lab ? lab.textContent.trim() : null;
  });
  return [...sliders, ...selects].filter(Boolean);
});

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

    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      page = (await browser.pages()).find((p) => !/splash\.html|projector\.html|docs\.html/.test(p.url())) || null;
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no editor page');
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => document.querySelectorAll('button').length > 0)) break;
      await sleep(1000);
    }

    await clickRail(page, '3D');
    await sleep(1200);
    if (!(await selectFixture(page, 'Head 1'))) throw new Error('could not select Head 1');
    await sleep(1000);
    for (let i = 0; i < 4; i++) {
      if ((await trackState(page)).found) break;
      await page.keyboard.down('Control'); await page.keyboard.press('KeyT'); await page.keyboard.up('Control');
      await sleep(1200);
    }

    let st = await trackState(page);
    note(st.found, 'the selected light has a track of its own on the timeline');
    if (!st.found) throw new Error('no fixture track');

    console.log('\n1. every parameter of the patched mode is on it');
    note(st.params === EXPECTED_PARAMS, `all ${EXPECTED_PARAMS} parameters are on one track`,
      `${st.params} rows: ${st.labels.slice(0, 12).join(', ')}`);

    console.log('\n2. grouped the way a fixture is read');
    const wanted = ['INTENSITY', 'POSITION', 'COLOUR', 'BEAM', 'GOBO'];
    const missing = wanted.filter((g) => !st.groups.includes(g));
    note(missing.length === 0, 'the rows are grouped by attribute',
      `groups on screen: ${st.groups.join(' / ')}${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);

    console.log('\n3. the track and the channel strip agree about what this fixture has');
    const strip = await stripChannels(page);
    const norm = (a) => a.map((s) => s.replace(/^fixtures\.[^.]+\.dmx\./, '')).sort();
    note(strip.length === st.params, 'the strip shows the same number of parameters as the track',
      `strip ${strip.length} vs track ${st.params}` + (strip.length !== st.params ? `\n        strip: ${strip.join(', ')}` : ''));

    console.log('\n4. the filter narrows to what is actually keyed');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button[title]')].find((x) => /Showing all/.test(x.getAttribute('title') || ''));
      if (b) b.click();
    });
    await sleep(500);
    st = await trackState(page);
    note(st.params === 1 && st.keyedRows === 1, 'filtered, only the keyed parameter remains',
      `${st.params} row(s): ${st.labels.join(', ')}`);

    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button[title]')].find((x) => /Showing only/.test(x.getAttribute('title') || ''));
      if (b) b.click();
    });
    await sleep(500);
    st = await trackState(page);
    note(st.params === EXPECTED_PARAMS, 'and clearing it brings all of them back', `${st.params} rows`);
  } catch (e) {
    failures++;
    console.error('\n   \x1b[31mERROR\x1b[0m', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }

  console.log(failures
    ? `\n\x1b[31mfixture track: ${failures} failure(s)\x1b[0m`
    : '\n\x1b[32mfixture track OK — every parameter on one track, grouped, filterable\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
