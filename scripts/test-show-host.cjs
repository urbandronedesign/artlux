// Runtime proof of the Show Host link (E5/W3a, plans/native-engine.md §9a).
//
//   node scripts/test-show-host.cjs [--keep]
//
// THE CLAIMS.
//   1. The editor connects to the Show Host (a utilityProcess) and hands it its whole state.
//   2. The replica and the authority hold THE SAME document: every slice of both stores digests
//      identically on both sides (window.__showHost.verify(): the host digests, the page compares).
//   3. An edit reaches the host, and the two still agree afterwards.
//   4. Nothing writes the document PER FRAME: over a few seconds of a running editor, the slices sent
//      to the host stay in single figures (one per frame would be hundreds). A structural check, not a
//      timing measurement: replication costs what the document's rate of change costs, nothing more.
//   5. A DEAD HOST IS NOT A DEAD EDITOR. The harness kills the host process; the editor keeps editing,
//      main forks a fresh host, the editor reconnects and hands it its state, and the two agree again.
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
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9386';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-show-host-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'show-host-test.artlux');
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
    timeline: { layers: [], clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [] },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}
const MAIN_LOG = path.join(os.tmpdir(), 'artlux-show-host-test.main.log');
function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    // main's console goes to a file: step 5 reads the [showHost] lines back when it fails.
    // ONE descriptor for both streams: two (a 'w' and an 'a') overwrite each other's lines.
    { cwd: ROOT, env, stdio: ['ignore', ...(() => { const fd = fs.openSync(MAIN_LOG, 'w'); return [fd, fd]; })()], shell: process.platform === 'win32' });
}
const hostLog = () => { try { return fs.readFileSync(MAIN_LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[showHost]')); } catch { return []; } };
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
const clickRow = async (page, name, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const ok = await page.evaluate((n) => {
      const leaf = [...document.querySelectorAll('div[role="button"] *')]
        .find((e) => e.children.length === 0 && (e.textContent || '').trim() === n);
      const row = leaf ? leaf.closest('div[role="button"]') : null;
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }, name);
    if (ok) { await sleep(400); return true; }
    await sleep(500);
  }
  return false;
};
const reverseBox = (page) => page.evaluate(() => {
  const lab = [...document.querySelectorAll('span')].find((s) => (s.textContent || '').trim() === 'Reverse Direction');
  let row = lab; while (row && !row.querySelector('input[type="checkbox"]')) row = row.parentElement;
  const cb = row && row.querySelector('input[type="checkbox"]');
  return cb ? cb.checked : null;
});
const clickReverse = (page) => page.evaluate(() => {
  const lab = [...document.querySelectorAll('span')].find((s) => (s.textContent || '').trim() === 'Reverse Direction');
  let row = lab; while (row && !row.querySelector('input[type="checkbox"]')) row = row.parentElement;
  const cb = row && row.querySelector('input[type="checkbox"]');
  if (cb) cb.click();
  return !!cb;
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
      page = (await browser.pages()).find((p) => /localhost:3000/.test(p.url()) && !/splash\.html|projector\.html|docs\.html/.test(p.url())) || null;
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no editor page');
    const sh = (fn, ...args) => page.evaluate(fn, ...args);
    const pageLog = [];
    page.on('console', (m) => { const t = m.text(); if (t.includes('[hostLink]')) pageLog.push(t); });
    // A cold dev start transforms the whole module graph first: the app (and so the link) is not running
    // for a while after the page exists. Wait for the UI as every harness here does, then for the link.
    for (let i = 0; i < 90; i++) { if (await sh(() => document.querySelectorAll('button').length > 3).catch(() => false)) break; await sleep(1000); }
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) { ok = await sh(() => !!window.__showHost && window.__showHost.connected() && window.__showHost.pid() != null); if (!ok) await sleep(500); }

    console.log('\n1. the editor connects to the Show Host');
    note(ok, 'connected, and the host said who it is', ok ? `host pid ${await sh(() => window.__showHost.pid())}` : 'no connection within 15 s');
    if (!ok) throw new Error('no Show Host connection');
    const unclonable = await sh(() => window.__showHost.unclonable());
    note(unclonable.length === 0, 'every slice structured-clones', unclonable.length ? `not replicated: ${unclonable.join(', ')}` : '');

    await clickRail(page, 'Map');
    await sleep(1500);
    if (!(await clickRow(page, 'Strip 1'))) throw new Error('could not select Strip 1 — the project did not load');
    await sleep(800);

    console.log('\n2. the replica and the authority hold the same document');
    let v = await sh(() => window.__showHost.verify());
    note(!!v && v.compared >= 20 && v.mismatched.length === 0, 'every slice digests identically on both sides',
      v ? `${v.compared} slices compared${v.mismatched.length ? `; differ: ${v.mismatched.join(', ')}` : ''}` : 'the host did not answer');

    console.log('\n3. an edit reaches the host');
    const before = await reverseBox(page);
    await clickReverse(page);
    await sleep(800);
    const after = await reverseBox(page);
    note(before !== null && after === !before, 'the edit landed in the editor', `reverse ${before} → ${after}`);
    v = await sh(() => window.__showHost.verify());
    note(!!v && v.mismatched.length === 0, 'the host has it too', v ? (v.mismatched.length ? `differ: ${v.mismatched.join(', ')}` : `${v.compared} slices agree`) : 'no answer');

    console.log('\n4. nothing writes the document per frame');
    await sh(() => window.__showHost.resetStats());
    await sleep(3000);
    const stats = await sh(() => window.__showHost.stats());
    const docSends = Object.entries(stats).filter(([k]) => k.startsWith('doc.')).reduce((n, [, c]) => n + c, 0);
    note(docSends < 10, 'over 3 s of a running editor, the document was sent fewer than 10 times',
      `${docSends} doc sends${Object.keys(stats).length ? ` — ${Object.entries(stats).map(([k, c]) => `${k}×${c}`).join(' ')}` : ''}`);

    console.log('\n5. a dead host is not a dead editor');
    const pid1 = await sh(() => window.__showHost.pid());
    const connects1 = await sh(() => window.__showHost.connects());
    // taskkill /F on Windows: Node's process.kill(pid) returned without error and left the utility
    // process running (measured). A kill that did not happen would make every check below vacuous, so
    // it is confirmed: the old pid must be gone before anything else is believed.
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${pid1} /F`, { stdio: 'ignore' });
      else process.kill(pid1, 'SIGKILL');
    } catch (e) { note(false, 'killed the host process', e.message); }
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let gone = false;
    for (let i = 0; i < 20 && !gone; i++) { gone = !alive(pid1); if (!gone) await sleep(100); }
    note(gone, 'the host process is really dead', `pid ${pid1}`);
    // Edit while the host is down (or restarting): the editor must not care.
    await sleep(150);
    await clickReverse(page);
    await sleep(400);
    const duringOutage = await reverseBox(page);
    note(duringOutage === !after, 'an edit made while the host is down still lands in the editor', `reverse ${after} → ${duringOutage}`);
    // Back = a NEW connect AND the new host's welcome (a pid that is not the dead one). The pid alone is
    // never null after the first welcome, so waiting on "pid != null" stopped on the reconnect itself,
    // before the fresh host had said who it was, and failed about half the runs.
    let back = false;
    const t0 = Date.now();
    for (let i = 0; i < 60 && !back; i++) { back = await sh((c, old) => window.__showHost.connects() > c && window.__showHost.pid() !== old, connects1, pid1); if (!back) await sleep(500); }
    const restartMs = Date.now() - t0;
    const pid2 = await sh(() => window.__showHost.pid());
    console.log(`        reconnected ${back ? `after ${restartMs} ms` : 'never'} (from the kill confirmation)`);
    note(back && pid2 !== pid1, 'main forked a fresh host and the editor reconnected', `pid ${pid1} → ${pid2}`);
    if (!(back && pid2 !== pid1)) {
      console.log(`        main log:\n          ${hostLog().join('\n          ')}`);
      console.log(`        page: ${JSON.stringify(await sh(() => ({ pid: window.__showHost.pid(), connects: window.__showHost.connects(), connected: window.__showHost.connected() })))}`);
      console.log(`        page log:\n          ${pageLog.join('\n          ')}`);
    }
    v = await sh(() => window.__showHost.verify());
    note(!!v && v.mismatched.length === 0, "the fresh host holds the editor's document, including the outage edit",
      v ? (v.mismatched.length ? `differ: ${v.mismatched.join(', ')}` : `${v.compared} slices agree`) : 'no answer');
  } catch (e) {
    failures++;
    console.error('\nharness error:', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    restorePrefs();
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
  console.log(failures ? `\n\x1b[31mshow host: ${failures} failure(s)\x1b[0m` : '\n\x1b[32mshow host OK — the editor and the authority hold one document, and a dead host loses nothing\x1b[0m');
  process.exitCode = failures ? 1 : 0;
})();
