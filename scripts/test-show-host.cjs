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
//   5. UNDO LIVES IN THE HOST (W3b): Ctrl+Z and Ctrl+Y are host ops (the editor's op counters move,
//      the host reports the stack depth), the document comes back on both sides, and the fixture the
//      edit did NOT touch is still the same object afterwards (shareEqual), as it was when undo
//      restored references in-process.
//   6. "UNSAVED CHANGES" IS THE HOST'S ANSWER (W3c): an edit lights the indicator, undoing back to the
//      saved content clears it (a content compare, not a revision count), redo lights it, a save
//      clears it (saved through the indicator button) — and the editor's own state agrees with the host's at every step.
//   7. A DEAD HOST IS NOT A DEAD EDITOR. The harness kills the host process; the editor keeps editing,
//      main forks a fresh host, the editor reconnects and hands it its state, and the two agree again.
//   8. AUTOSAVE (W3c): the host writes a recovery copy of an unsaved edit (cadence shortened for the
//      harness) and leaves the project file alone; the harness CRASHES the editor renderer, main reloads
//      it, and the editor offers the work back; Restore puts it back as one undoable step with the project
//      unsaved; saving writes it and retires the autosave. Only this harness's autosaves are touched.
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
  env.ARTLUX_AUTOSAVE_MS = '1500';
  env.ARTLUX_AUTOSAVE_DIR = AUTOSAVE_DIR;   // step 8: the autosave timer, at harness speed (30 s in the app)
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    // main's console goes to a file: step 5 reads the [showHost] lines back when it fails.
    // ONE descriptor for both streams: two (a 'w' and an 'a') overwrite each other's lines.
    { cwd: ROOT, env, stdio: ['ignore', ...(() => { const fd = fs.openSync(MAIN_LOG, 'w'); return [fd, fd]; })()], shell: process.platform === 'win32' });
}
const hostLog = () => { try { return fs.readFileSync(MAIN_LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[showHost]')); } catch { return []; } };
async function stop(child) {
  // ITS OWN TREE, never every electron.exe: the owner's own session may be open beside the test. The
  // tree kill goes FIRST — killing the npm shell alone orphans the app, and the walk then finds nothing.
  try { execSync(process.platform === 'win32' ? `taskkill /PID ${child.pid} /F /T` : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  await sleep(2000);
}

// The autosaves the host wrote for THIS harness's project. The app is pointed at a folder inside WORK
// (ARTLUX_AUTOSAVE_DIR, set in launch()), so the owner's real autosave folder is never written; files are
// still matched by the projectPath recorded inside them.
const AUTOSAVE_DIR = path.join(WORK, 'autosave');
let HARNESS_PROJECT = null;
const samePath = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function ourAutosaves() {
  let names = [];
  try { names = fs.readdirSync(AUTOSAVE_DIR).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(AUTOSAVE_DIR, n), 'utf8'));
      if (j.kind !== 'artlux-autosave' || !samePath(j.projectPath, HARNESS_PROJECT)) continue;
      const strip = (j.slices.fixtures || []).find((f) => f.name === 'Strip 1');
      out.push({ file: path.join(AUTOSAVE_DIR, n), savedAt: j.savedAt, reverse: strip ? strip.reverse : null });
    } catch { /* not ours, or mid-write */ }
  }
  return out;
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
  HARNESS_PROJECT = project;
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

    console.log('\n5. undo lives in the host');
    {
      const press = async (key) => {
        await sh(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
        await page.mouse.move(120, 140);
        await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control');
        await sleep(700);
      };
      const h0 = await sh(() => window.__showHost.history());
      const id0 = await sh(() => window.__showHost.identity('doc', 'fixtures'));
      const r0 = await reverseBox(page);
      await clickReverse(page);
      await sleep(700);
      const r1 = await reverseBox(page);
      const h1 = await sh(() => window.__showHost.history());
      note(r1 === !r0 && (h1.ops.record || 0) > (h0.ops.record || 0) && h1.canUndo,
        'the edit was recorded in the host', `reverse ${r0} → ${r1}; record ops ${h0.ops.record || 0} → ${h1.ops.record || 0}; host depth ${h1.depth}`);
      await press('KeyZ');
      const r2 = await reverseBox(page);
      const h2 = await sh(() => window.__showHost.history());
      const id2 = await sh(() => window.__showHost.identity('doc', 'fixtures'));
      note(r2 === r0 && (h2.ops.undo || 0) > (h1.ops.undo || 0) && h2.canRedo, 'Ctrl+Z is a host op and the edit comes back',
        `reverse ${r1} → ${r2}; undo ops ${h1.ops.undo || 0} → ${h2.ops.undo || 0}; canRedo ${h2.canRedo}`);
      // Strip 2 (index 1) was never touched: after the edit AND its undo it must be the SAME object.
      note(id0.items.length === 2 && id2.items.length === 2 && id2.items[1] === id0.items[1],
        'the untouched fixture kept its identity through the edit and the undo', `fixture object ids ${JSON.stringify(id0.items)} → ${JSON.stringify(id2.items)}`);
      v = await sh(() => window.__showHost.verify());
      note(!!v && v.mismatched.length === 0, 'after the undo the two sides agree', v ? (v.mismatched.length ? `differ: ${v.mismatched.join(', ')}` : `${v.compared} slices agree`) : 'no answer');
      await press('KeyY');
      const r3 = await reverseBox(page);
      const h3 = await sh(() => window.__showHost.history());
      note(r3 === r1 && (h3.ops.redo || 0) > (h2.ops.redo || 0), 'Ctrl+Y is a host op and redoes it', `reverse ${r2} → ${r3}; redo ops ${h2.ops.redo || 0} → ${h3.ops.redo || 0}`);
      v = await sh(() => window.__showHost.verify());
      note(!!v && v.mismatched.length === 0, 'after the redo the two sides agree', v ? (v.mismatched.length ? `differ: ${v.mismatched.join(', ')}` : `${v.compared} slices agree`) : 'no answer');
    }

    console.log('\n6. "unsaved changes" is the host\'s answer');
    {
      const indicator = () => sh(() => {
        const el = [...document.querySelectorAll('button[title]')].find((e) => /Unsaved changes|Everything is saved|Not stored into/.test(e.getAttribute('title') || ''));
        return el ? (/Everything is saved/.test(el.getAttribute('title')) ? 'saved' : 'unsaved') : null;
      });
      const key = async (k, shift = false) => {
        await sh(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
        await page.mouse.move(120, 140);
        await page.keyboard.down('Control'); if (shift) await page.keyboard.down('Shift');
        await page.keyboard.press(k);
        if (shift) await page.keyboard.up('Shift'); await page.keyboard.up('Control');
      };
      // SAVE THROUGH THE UI, not Ctrl+S: Ctrl+S is a NATIVE MENU accelerator, and keys sent over CDP never
      // reach one (measured: two "Ctrl+S" presses, zero saves — the first 'saved' was the project settling).
      // The indicator button is Save All, which with no scene look pending is a plain save.
      const save = async () => {
        const b0 = (await sh(() => window.__showHost.dirty())).baselines;
        await sh(() => { const el = [...document.querySelectorAll('button[title]')].find((e) => /Unsaved changes|Everything is saved/.test(e.getAttribute('title') || '')); if (el) el.click(); });
        for (let i = 0; i < 20; i++) { if ((await sh(() => window.__showHost.dirty())).baselines > b0) return true; await sleep(200); }
        return false;
      };
      // Wait for a state, with the host and the indicator agreeing: up to 4 s (the poll is 1 Hz).
      const settleTo = async (want) => {
        let ind = null, host = null;
        for (let i = 0; i < 20; i++) {
          ind = await indicator(); host = (await sh(() => window.__showHost.dirty())).dirty;
          if (ind === want && host === (want === 'unsaved')) return { ok: true, ind, host };
          await sleep(200);
        }
        return { ok: false, ind, host };
      };
      // Start from a saved file, so every later state has a known reference.
      let saved = await save();
      let s = await settleTo('saved');
      note(saved && s.ok, 'after a save the project reads as saved, on both sides', `indicator ${s.ind}, host dirty ${s.host}`);
      await clickReverse(page);
      s = await settleTo('unsaved');
      note(s.ok, 'an edit makes it unsaved, and the host says so', `indicator ${s.ind}, host dirty ${s.host}`);
      await key('KeyZ');
      s = await settleTo('saved');
      note(s.ok, 'undoing back to the saved content makes it saved again (content, not a revision count)', `indicator ${s.ind}, host dirty ${s.host}`);
      await key('KeyY');
      s = await settleTo('unsaved');
      note(s.ok, 'redo makes it unsaved again', `indicator ${s.ind}, host dirty ${s.host}`);
      saved = await save();
      s = await settleTo('saved');
      note(saved && s.ok, 'saving makes it saved', `indicator ${s.ind}, host dirty ${s.host}`);
      if (!s.ok) console.log(`        host says these differ from the save: ${JSON.stringify((await sh(() => window.__showHost.verify()))?.unsaved)}`);
    }

    console.log('\n7. a dead host is not a dead editor');
    const pid1 = await sh(() => window.__showHost.pid());
    const beforeOutage = await reverseBox(page);   // the box as it is NOW (step 5 flipped it since step 3)
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
    note(duringOutage === !beforeOutage, 'an edit made while the host is down still lands in the editor', `reverse ${beforeOutage} → ${duringOutage}`);
    // Back = a NEW connect AND the new host's welcome (a pid that is not the dead one). The pid alone is
    // never null after the first welcome, so waiting on "pid != null" stopped on the reconnect itself,
    // before the fresh host had said who it was, and failed about half the runs.
    let back = false;
    const t0 = Date.now();
    for (let i = 0; i < 60 && !back; i++) { back = await sh((c, old) => window.__showHost.connects() > c && window.__showHost.pid() != null && window.__showHost.pid() !== old, connects1, pid1); if (!back) await sleep(500); }
    const restartMs = Date.now() - t0;
    const pid2 = await sh(() => window.__showHost.pid());
    console.log(`        reconnected ${back ? `after ${restartMs} ms` : 'never'} (timed from after the outage edit, ~0.5 s after the kill)`);
    note(back && pid2 !== pid1, 'main forked a fresh host and the editor reconnected', `pid ${pid1} → ${pid2}`);
    if (!(back && pid2 !== pid1)) {
      console.log(`        main log:\n          ${hostLog().join('\n          ')}`);
      console.log(`        page: ${JSON.stringify(await sh(() => ({ pid: window.__showHost.pid(), connects: window.__showHost.connects(), connected: window.__showHost.connected() })))}`);
      console.log(`        page log:\n          ${pageLog.join('\n          ')}`);
    }
    v = await sh(() => window.__showHost.verify());
    note(!!v && v.mismatched.length === 0, "the fresh host holds the editor's document, including the outage edit",
      v ? (v.mismatched.length ? `differ: ${v.mismatched.join(', ')}` : `${v.compared} slices agree`) : 'no answer');

    console.log('\n8. autosave keeps unsaved work, and a crash gives it back');
    {
      const save = async () => {
        const b0 = (await sh(() => window.__showHost.dirty())).baselines;
        await sh(() => { const el = [...document.querySelectorAll('button[title]')].find((e) => /Unsaved changes|Everything is saved/.test(e.getAttribute('title') || '')); if (el) el.click(); });
        for (let i = 0; i < 20; i++) { if ((await sh(() => window.__showHost.dirty())).baselines > b0) return true; await sleep(200); }
        return false;
      };
      // Start saved: whatever the outage step left is written to the file, and no autosave stands.
      note(await save(), 'the project is saved before the test', '');
      await sleep(800);
      const fileReverse = () => { try { return JSON.parse(fs.readFileSync(project, 'utf8')).fixtures.find((f) => f.name === 'Strip 1').reverse; } catch { return null; } };
      const onDisk0 = fileReverse();
      const before = await reverseBox(page);
      await clickReverse(page);
      const edited = await reverseBox(page);
      note(edited === !before, 'an unsaved edit', `reverse ${before} → ${edited}`);
      // The timer (ARTLUX_AUTOSAVE_MS=1500 for this harness) writes a recovery copy: find it.
      let auto = null;
      for (let i = 0; i < 25 && !auto; i++) {
        await sleep(200);
        auto = ourAutosaves().find((a) => a.reverse === edited) || null;
      }
      note(!!auto, 'the host autosaved it within seconds', auto ? `${path.basename(auto.file)}, saved ${auto.savedAt}` : `autosaves for this project: ${JSON.stringify(ourAutosaves())}`);
      note(fileReverse() === onDisk0, 'and the project FILE was not touched', `file reverse ${onDisk0} → ${fileReverse()}`);

      // Crash the editor renderer. Main's editor recovery reloads it on the last project, and the work
      // the crashed page never saved must be offered back.
      // Recovery reloads the SAME window (the same CDP target), so the new page is told apart from the
      // crashed one by a mark the crashed document carried, not by object identity.
      await sh(() => { window.__beforeCrash = true; });
      const cdp = await page.createCDPSession();
      try { await cdp.send('Page.crash'); } catch { /* the session dies with the page */ }
      let next = null;
      for (let i = 0; i < 60 && !next; i++) {
        await sleep(500);
        for (const p of await browser.pages()) {
          if (!/localhost:3000/.test(p.url()) || /splash\.html|projector\.html|docs\.html/.test(p.url())) continue;
          const ready = await p.evaluate(() => !window.__beforeCrash && document.querySelectorAll('button').length > 3 && !!window.__showHost).catch(() => false);
          if (ready) { next = p; break; }
        }
      }
      note(!!next, 'the editor came back after the renderer crash', next ? next.url().slice(0, 80) : 'no new editor page');
      if (!next) throw new Error('no editor after the crash');
      page = next;
      let asked = false;
      for (let i = 0; i < 40 && !asked; i++) {
        asked = await sh(() => [...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === 'Restore') && /Restore unsaved changes\?/.test(document.body.innerText));
        if (!asked) await sleep(250);
      }
      note(asked, 'it offers the unsaved changes back', asked ? '"Restore unsaved changes?"' : 'no dialog');
      if (asked) {
        await sh(() => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Restore').click());
        await sleep(1200);
        if (!(await clickRow(page, 'Strip 1'))) throw new Error('could not select Strip 1 after the restore');
        await sleep(600);
        const restored = await reverseBox(page);
        note(restored === edited, 'Restore puts the unsaved edit back', `reverse ${restored} (the crashed page had ${edited}, the file ${onDisk0})`);
        let unsaved = false;
        for (let i = 0; i < 20 && !unsaved; i++) { unsaved = (await sh(() => window.__showHost.dirty())).dirty; if (!unsaved) await sleep(200); }
        note(unsaved, 'and the project reads as unsaved — the file still holds the old value', `host dirty ${unsaved}`);
        await sh(() => { if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); });
        await page.mouse.move(120, 140);
        await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control');
        await sleep(800);
        note(await reverseBox(page) === onDisk0, 'the restore is ONE undo step: Ctrl+Z gives the file version back', `reverse ${await reverseBox(page)}`);
        await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control');
        await sleep(800);
        note(await save(), 'saving the restored work', '');
        await sleep(800);
        note(fileReverse() === edited && ourAutosaves().length === 0, 'the file now holds it, and the autosave is retired',
          `file reverse ${fileReverse()}; autosaves left ${ourAutosaves().length}`);
      }
    }
  } catch (e) {
    failures++;
    console.error('\nharness error:', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    restorePrefs();
    for (const a of ourAutosaves()) { try { fs.unlinkSync(a.file); } catch { /* gone */ } }   // only this harness's
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
  console.log(failures ? `\n\x1b[31mshow host: ${failures} failure(s)\x1b[0m` : '\n\x1b[32mshow host OK — the editor and the authority hold one document, and a dead host loses nothing\x1b[0m');
  process.exitCode = failures ? 1 : 0;
})();
