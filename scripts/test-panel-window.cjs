// Runtime proof of panel windows (E5/W5a, plans/native-engine.md §9a).
//
//   node scripts/test-panel-window.cjs [--keep]
//
// THE CLAIMS.
//   1. A detachable panel opens in its OWN window (panel.html), and shows the OPEN PROJECT — the Show
//      Host's document, not the built-in defaults a fresh page starts with.
//   2. The panel window PRODUCES NOTHING: no broker, no thumbnail cache, no transport, engine, GPU or
//      three.js module loaded (dev serves modules one by one, so the loaded set is visible), and its
//      replica is read-only (role 'panel', zero slices sent to the host).
//   3. An edit made IN the panel window runs in the editor (its "Add Fixture" button → App's handler):
//      the editor, the host and the panel window all end with the same document.
//   4. The other way: a selection made in the EDITOR reaches the panel window.
//   5. A slider in the panel window drives the editor's render-free channel while dragged, and commits
//      on release — in the editor's document, the host's and the panel's.
//   6. A panel window that CRASHES mid-drag has its drag released by the editor (main's 'drop' notice
//      from a real second window — the path W4 could only simulate).
//   7. Its place is remembered: reopened after a close it comes back at the same bounds; a window
//      pushed off every screen comes back ON one.
// Restores the whole prefs file, like every harness here (panel positions are written to it).

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
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9388';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-panel-window-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'panel-window-test.artlux');
  const strip = (id, name, y, addr) => ({
    id, name, x: 0.1, y, width: 0.5, height: 0.04, rotation: 0,
    universe: 0, startAddress: addr, ledCount: 30, reverse: false, colorData: [], surfaceId: 'sf_wall',
  });
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [{ id: 'sf_wall', name: 'Wall 1', x: 0.05, y: 0.05, width: 0.9, height: 0.9, rotation: 0, zIndex: 0, content: { type: 'NONE' } }],
    fixtures: [strip('fx_a', 'Strip Alpha', 0.2, 1), strip('fx_b', 'Strip Bravo', 0.4, 91)],
    controllers: [{ id: 'ctl', name: 'Main', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0 }],
    globalBrightness: 1, groups: [], scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false },
    timeline: { layers: [], clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [] },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}
const MAIN_LOG = path.join(os.tmpdir(), 'artlux-panel-window-test.main.log');
function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', ...(() => { const fd = fs.openSync(MAIN_LOG, 'w'); return [fd, fd]; })()], shell: process.platform === 'win32' });
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
const until = async (fn, ms = 8000, step = 200) => {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
};

(async () => {
  if (!puppeteer) { console.error('puppeteer-core not installed — run npm install'); process.exit(1); }
  const project = buildProject();
  let child = launch(project);
  let browser = null;
  const connect = async () => {
    let up = null;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { /* not yet */ } }
    if (!up) throw new Error('the app never opened its CDP port');
    return puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
  };
  try {
    browser = await connect();
    let ed = null;
    for (let i = 0; i < 40 && !ed; i++) {
      ed = (await browser.pages()).find((p) => /localhost:3000\/?(index\.html)?(\?|$)/.test(p.url())) || null;
      if (!ed) await sleep(1000);
    }
    if (!ed) throw new Error('no editor page');
    const E = (fn, ...a) => ed.evaluate(fn, ...a);
    for (let i = 0; i < 90; i++) { if (await E(() => document.querySelectorAll('button').length > 3 && !!window.__showHost && window.__showHost.connected()).catch(() => false)) break; await sleep(1000); }
    await sleep(2500);
    // The Map workbench docks the Fixtures outliner in the editor too (step 4 clicks a row there).
    await E(() => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === 'Map'); if (b) b.click(); });
    await sleep(1200);
    const edNames = () => E(() => window.__showHost.get('doc', 'fixtures').map((f) => f.name));
    if (!(await edNames()).includes('Strip Alpha')) throw new Error('the project did not load in the editor');

    const openPanel = async (id, viaHeader) => {
      if (viaHeader) {
        // The operator's door: the button in the panel's own section header in the editor.
        const ok = await E((title) => {
          const leaf = [...document.querySelectorAll('span, div')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === title);
          let n = leaf;
          for (let i = 0; n && i < 6; i++, n = n.parentElement) {
            const b = n.querySelector('button[title="Open in new window"]');
            if (b) { b.click(); return true; }
          }
          return false;
        }, viaHeader);
        if (!ok) throw new Error(`no "Open in new window" button in the editor's ${viaHeader} section header`);
      } else await E((pid) => window.artlux.openPanelWindow(pid), id);
      const t = await browser.waitForTarget((x) => x.url().includes(`panel.html?panel=${encodeURIComponent(id)}`), { timeout: 20000 });
      const p = await t.page();
      // The window is fresh: wait until its replica holds the host's document and the panel rendered.
      await until(() => p.evaluate(() => !!window.__showHost && window.__showHost.ready() && !/Connecting/.test(document.body.innerText)), 30000);
      return p;
    };

    console.log('\n1. a detachable panel opens in its own window, showing the open project');
    const pf = await openPanel('core.browser.fixtures', 'Fixtures');
    const P = (fn, ...a) => pf.evaluate(fn, ...a);
    const text = await P(() => document.body.innerText);
    note(/Strip Alpha/.test(text) && /Strip Bravo/.test(text) && !/Main Arch/.test(text),
      'the panel window lists the project\'s fixtures (not the built-in default)', text.split('\n').slice(0, 6).join(' | '));
    note((await P(() => document.title)).startsWith('Fixtures'), 'the window is titled after its panel', await P(() => document.title));

    console.log('\n2. the panel window produces nothing');
    // Fingerprints the producers leave on `window` the moment their module is evaluated: the transport
    // (services/timeline sets __artluxNullLog), the thumbnail cache, the live broker, three.js (__THREE__).
    // The editor has every one of them, which is the control that the probe can see them at all. (The
    // build-time half of this claim is verify:invariants, which bundles panel.tsx.)
    const prints = () => ({ timeline: !!window.__artluxNullLog, thumbs: !!window.__artluxThumbs, broker: !!window.__liveBroker, three: !!window.__THREE__ });
    const inEditor = await E(prints);
    const inPanel = await P(prints);
    note(Object.values(inEditor).filter(Boolean).length >= 3, 'control: the editor shows the producer fingerprints', JSON.stringify(inEditor));
    note(!Object.values(inPanel).some(Boolean), 'the panel window shows none of them: no transport, thumbnail cache, broker or three.js', JSON.stringify(inPanel));
    const role = await P(() => ({ role: window.__showHost.role(), sent: Object.values(window.__showHost.stats()).reduce((a, b) => a + b, 0) }));
    note(role.role === 'panel' && role.sent === 0, 'its replica is read-only: role panel, nothing sent to the host', JSON.stringify(role));

    console.log('\n3. an edit in the panel window runs in the editor');
    const before = (await edNames()).length;
    const clicked = await P(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('title') === 'Add Fixture'); if (b) b.click(); return !!b; });
    note(clicked, 'the panel window has the panel\'s own header buttons (Add Fixture)');
    const grew = await until(async () => (await edNames()).length === before + 1);
    note(!!grew, 'the editor ran it: one more fixture', `editor fixtures ${before} → ${(await edNames()).length}`);
    const pNames = await until(async () => { const n = await P(() => window.__showHost.get('doc', 'fixtures').map((f) => f.name)); return n.length === before + 1 ? n : null; });
    note(!!pNames, 'the panel window\'s replica has it too', pNames ? pNames.join(', ') : '');
    const v = await E(() => window.__showHost.verify());
    note(!!v && v.mismatched.length === 0, 'the editor and the host still agree on every slice', v ? `${v.compared} compared${v.mismatched.length ? `, differ: ${v.mismatched.join(', ')}` : ''}` : 'no answer');

    console.log('\n4. a selection in the editor reaches the panel window');
    await E(() => {
      const leaf = [...document.querySelectorAll('div[role="button"] *')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Strip Bravo');
      const row = leaf && leaf.closest('div[role="button"]');
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    const sel = await until(() => P(() => window.__showHost.get('session', 'selectedFixtureId') === 'fx_b'));
    note(!!sel, 'the panel window\'s session says Strip Bravo is selected');
    // And the other way: a click on a row IN the panel window selects in the editor.
    await P(() => {
      const leaf = [...document.querySelectorAll('div[role="button"] *')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Strip Alpha');
      const row = leaf && leaf.closest('div[role="button"]');
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    const sel2 = await until(() => E(() => window.__showHost.get('session', 'selectedFixtureId') === 'fx_a'));
    note(!!sel2, 'a click in the panel window selects in the editor');

    console.log('\n5. a slider in a panel window drags live in the editor, commits on release');
    const pg = await openPanel('core.browser.globals');
    const G = (fn, ...a) => pg.evaluate(fn, ...a);
    const drag = (to, release) => G((t, rel) => {
      const lab = [...document.querySelectorAll('label')].find((e) => (e.textContent || '').trim() === 'LED Brightness');
      const r = lab && document.getElementById(lab.htmlFor);
      if (!r) return false;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(t));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      if (rel) r.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    }, to, release);
    const live = () => E(() => getComputedStyle(document.documentElement).getPropertyValue('--preview-brightness').trim());
    note(await drag(0.4, false), 'the Global Params window has its LED Brightness slider');
    const during = await until(async () => ((await live()) === '0.4' ? '0.4' : null), 3000);
    const docDuring = await E(() => window.__showHost.get('doc', 'globalBrightness'));
    note(!!during && docDuring === 1, 'while dragged: the editor\'s live channel follows, the document does not', `live ${await live()}, document ${docDuring}`);
    await drag(0.4, true);
    const committed = await until(async () => (await E(() => window.__showHost.get('doc', 'globalBrightness'))) === 0.4, 4000);
    const pCommitted = await until(async () => (await G(() => window.__showHost.get('doc', 'globalBrightness'))) === 0.4, 4000);
    note(!!committed && !!pCommitted, 'on release it is committed, in the editor and in the panel\'s replica');

    console.log('\n6. a panel window that crashes mid-drag has its drag released');
    await drag(0.15, false);
    await until(async () => ((await live()) === '0.15' ? 1 : null), 3000);
    const heldBefore = await E(() => window.__liveBroker.clients().map((c) => c.held.length).reduce((a, b) => a + b, 0));
    const cdp = await pg.createCDPSession();
    await cdp.send('Page.crash').catch(() => { /* the session dies with the page */ });
    const released = await until(async () => ((await live()) === '0.4' ? 1 : null), 6000);
    note(heldBefore === 1 && !!released, 'the editor dropped the client and put the master back to the committed value',
      `held before ${heldBefore}; live now ${await live()} (committed 0.4)`);

    console.log('\n7. its place is remembered, it reopens with the editor, and never off-screen');
    const readPrefs = () => JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
    note(['core.browser.fixtures', 'core.browser.globals'].every((id) => (readPrefs().openPanelWindows || []).includes(id)),
      'the open panel windows are on the reopen list', JSON.stringify(readPrefs().openPanelWindows));
    await P(() => window.close());
    await sleep(1500);
    let prefs = readPrefs();
    const saved = (prefs.panelWindows || []).find((w) => w.panelId === 'core.browser.fixtures');
    note(!!saved && saved.displayId != null && saved.bounds.width > 0, 'closing a panel window remembers its bounds and its screen', JSON.stringify(saved));
    note(!(prefs.openPanelWindows || []).includes('core.browser.fixtures'), 'closed by the operator, it leaves the reopen list');
    if (!saved) throw new Error('nothing remembered');

    // SECOND LAUNCH. Electron does not implement CDP's window-bounds commands, so the positions are set
    // where main reads them — the prefs — with the app stopped: one at a known place on the screen main
    // recorded, one far off every screen. Both are put on the reopen list; the editor must bring them back.
    await browser.disconnect(); browser = null;
    await stop(child);
    const want = { x: saved.bounds.x - 30, y: saved.bounds.y + 20, width: 430, height: 510 };
    prefs = readPrefs();
    prefs.panelWindows = [
      { ...saved, bounds: want },
      { ...saved, panelId: 'core.browser.groups', bounds: { x: -20000, y: -20000, width: 430, height: 510 } },
    ];
    prefs.openPanelWindows = ['core.browser.fixtures', 'core.browser.groups'];
    fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
    child = launch(project);
    browser = await connect();
    const reopened = async (id) => {
      const t = await browser.waitForTarget((x) => x.url().includes(`panel.html?panel=${encodeURIComponent(id)}`), { timeout: 90000 }).catch(() => null);
      if (!t) return null;
      const p = await t.page();
      await until(() => p.evaluate(() => document.readyState === 'complete'), 30000);
      return p.evaluate(() => ({ x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight, ax: screen.availLeft, ay: screen.availTop, aw: screen.availWidth, ah: screen.availHeight }));
    };
    const bf = await reopened('core.browser.fixtures');
    const bg = await reopened('core.browser.groups');
    const near = (a, b) => Math.abs(a - b) <= 2;
    note(!!bf && near(bf.x, want.x) && near(bf.y, want.y) && near(bf.w, want.width) && near(bf.h, want.height),
      'reopened with the editor, at its remembered bounds on its remembered screen', `${JSON.stringify(want)} → ${JSON.stringify(bf)}`);
    const inside = (b) => b.x >= b.ax && b.y >= b.ay && b.x + b.w <= b.ax + b.aw && b.y + b.h <= b.ay + b.ah;
    note(!!bg && inside(bg), 'a window remembered off every screen comes back ON one', JSON.stringify(bg));
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
