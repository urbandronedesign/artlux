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
//   8. A PARAMETER SECTION in a window: a light's Channels fader holds the channel live in the editor
//      while dragged and commits on release; a section that does not apply says what to select.
//   9. Keys in a panel window: Ctrl+Z / Ctrl+Shift+Z undo and redo in the editor, Space plays and
//      pauses its transport, Ctrl+S saves the project.
//  10. A WINDOW IS A WORKBENCH OF ITS OWN: "+" adds a panel as a tab; asking the editor for a panel
//      that is already out focuses that window on that tab; the tab menu splits; the arrangement is
//      saved; "Back to the editor" docks the panel into the editor's current workbench.
//  11. THE HOST DIES with a panel window open: it reconnects, never shows an empty or default
//      document in between, and edits from it still land (the new host agrees).
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
const readPrefsNow = () => { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } };
function restorePrefs() {
  if (!PREFS_BACKUP) return;
  try { fs.writeFileSync(PREFS_FILE, PREFS_BACKUP); console.log('prefs restored'); }
  catch (e) { console.log(`prefs NOT restored (${e.message}) — backup was taken from ${PREFS_FILE}`); }
}

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9388';
const KEEP = process.argv.includes('--keep');
// `ARTLUX_NO_SHOW_HOST=1 node scripts/test-panel-window.cjs` runs ONE claim instead: with the Show Host
// off, a panel window says it cannot show the project (instead of "Connecting…" forever).
const NOHOST = process.env.ARTLUX_NO_SHOW_HOST === '1';
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
    fixtures: [strip('fx_a', 'Strip Alpha', 0.2, 1), strip('fx_b', 'Strip Bravo', 0.4, 91),
      // A LIGHT (step 8): a bundled profile, its Channels section is the faders.
      { id: 'fx_wash', name: 'Wash Q4', x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0, universe: 0, startAddress: 300, ledCount: 1, reverse: false, colorData: [],
        profileId: 'american-dj/inno-pocket-beam-q4', profileMode: '13ch', controllerId: 'ctl', position3D: { x: 0, y: 4, z: 0 },
        dmx: { 'shutter-strobe': 12 / 255, dimmer: 1, pan: 0.5, tilt: 0.5, red: 1, green: 0, blue: 0, white: 0 } }],
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
    if (NOHOST) await ed.evaluateOnNewDocument(() => { window.__nohostRun = true; }).catch(() => {});
    if (NOHOST) await E(() => { window.__nohostRun = true; }).catch(() => {});
    for (let i = 0; i < 90; i++) { if (await E(() => document.querySelectorAll('button').length > 3 && !!window.__showHost && (window.__nohostRun || window.__showHost.connected())).catch(() => false)) break; await sleep(1000); }
    await sleep(2500);
    // The Map workbench docks the Fixtures outliner in the editor too (step 4 clicks a row there).
    await E(() => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === 'Map'); if (b) b.click(); });
    await sleep(1200);
    const edNames = () => E(() => window.__showHost.get('doc', 'fixtures').map((f) => f.name));
    if (!(await edNames()).includes('Strip Alpha')) throw new Error('the project did not load in the editor');

    if (NOHOST) {
      console.log('\n0. with no Show Host, a panel window says so');
      await E(() => window.artlux.openPanelWindow('core.browser.fixtures'));
      const t = await browser.waitForTarget((x) => x.url().includes('panel.html?panel='), { timeout: 20000 });
      const p = await t.page();
      await sleep(10000);   // past the 8 s grace period
      const txt = await p.evaluate(() => document.body.innerText);
      note(/cannot show the project right now/.test(txt) && /Show Host/.test(txt), 'the window explains instead of waiting forever', txt.replace(/\s+/g, ' ').slice(0, 160));
      throw Object.assign(new Error('done'), { done: true });
    }

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

    console.log('\n8. a parameter section in its own window: a light\'s Channels faders drive the editor live');
    await E(() => {
      const leaf = [...document.querySelectorAll('div[role="button"] *')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Wash Q4');
      const row = leaf && leaf.closest('div[role="button"]');
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    await until(() => E(() => window.__showHost.get('session', 'selectedFixtureId') === 'fx_wash'));
    const pc = await openPanel('core.inspector.fixture.channels');
    const C = (fn, ...a) => pc.evaluate(fn, ...a);
    const hasDimmer = await until(() => C(() => [...document.querySelectorAll('label')].some((l) => /^dimmer$/i.test((l.textContent || '').trim()) && l.htmlFor)), 10000);
    note(!!hasDimmer, 'the Channels window shows the selected light\'s faders', (await C(() => document.body.innerText)).split('\n').slice(0, 6).join(' | '));
    const dim = () => E(() => (window.__showHost.get('doc', 'fixtures').find((f) => f.id === 'fx_wash') || {}).dmx?.dimmer);
    const dim0 = await dim();
    const fader = (frac, release) => C((fr, rel) => {
      const lab = [...document.querySelectorAll('label')].find((l) => /^dimmer$/i.test((l.textContent || '').trim()) && l.htmlFor);
      const r = lab && document.getElementById(lab.htmlFor);
      if (!r) return null;
      const min = Number(r.min || 0), max = Number(r.max || 1);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(min + (max - min) * fr));
      r.dispatchEvent(new Event('input', { bubbles: true }));
      if (rel) r.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      return true;
    }, frac, release);
    await fader(0.25, false);
    const heldKeys = () => E(() => window.__liveBroker.clients().flatMap((c) => c.held).map((k) => k.split('\u0000').join('/')));
    const held = await until(async () => { const h = await heldKeys(); return h.includes('fixtureChannel/fx_wash/dimmer') ? h : null; }, 3000);
    note(!!held && (await dim()) === dim0, 'while dragged: the editor holds the channel live, the document is untouched', `held ${JSON.stringify(held)}, document dimmer ${await dim()}`);
    await fader(0.25, true);
    const committedDim = await until(async () => { const d = await dim(); return d !== dim0 && Math.abs(d - 0.25) < 0.02 ? d : null; }, 4000);
    const unheld = await until(async () => ((await heldKeys()).length === 0 ? 1 : null), 3000);
    note(!!committedDim && !!unheld, 'on release it is committed and the live hold is released', `document dimmer ${dim0} → ${await dim()}`);
    // Auto-key from the window: the arm is the EDITOR's (its button text comes back from the editor), and
    // a fader release then lands a keyframe on the editor's timeline.
    const arm = (want) => C((w) => {
      const b = [...document.querySelectorAll('button')].find((x) => /Record fader moves as keyframes|Recording — a fader writes a keyframe/.test(x.textContent || ''));
      if (!b) return null;
      const armed = /Recording/.test(b.textContent || '');
      if (armed !== w) b.click();
      return true;
    }, want);
    await arm(true);
    const armedBack = await until(() => C(() => /Recording — a fader writes a keyframe/.test(document.body.innerText)), 4000);
    await fader(0.6, false);
    await fader(0.6, true);
    const laneKey = await until(() => E(() => {
      const lanes = window.__showHost.get('doc', 'timeline').automation || [];
      const lane = lanes.find((l) => l.targetPath === 'fixtures.fx_wash.dmx.dimmer');
      return lane && lane.keyframes && lane.keyframes.length ? lane.keyframes.length : null;
    }), 4000);
    await arm(false);
    const disarmed = await until(() => C(() => /Record fader moves as keyframes/.test(document.body.innerText)), 4000);
    note(!!armedBack && !!laneKey && !!disarmed, 'arming auto-key in the window arms the editor, and a release keys its timeline',
      `armed ${!!armedBack}; keys on fixtures.fx_wash.dmx.dimmer: ${laneKey}; disarmed ${!!disarmed}`);
    const pt = await openPanel('core.inspector.surface.transform');
    const tText = await pt.evaluate(() => document.body.innerText);
    note(/Select a surface to see Transform/.test(tText), 'a section that does not apply to the selection says what to select', tText.trim().split('\n').pop());
    await pt.evaluate(() => window.close());

    console.log('\n9. keys in a panel window do what they do in the editor');
    const key = async (combo) => {
      const parts = combo.split('+');
      const k = parts.pop();
      for (const m of parts) await pc.keyboard.down(m);
      await pc.keyboard.press(k);
      for (const m of parts.reverse()) await pc.keyboard.up(m);
    };
    await C(() => document.body.focus());
    await key('Control+z');
    // The last edit is the auto-keyed release to 0.6 (fixtures AND its key, one undo step): undo lands on 0.25.
    const undone = await until(async () => (Math.abs((await dim()) - 0.25) < 0.02 ? 1 : null), 4000);
    note(!!undone, 'Ctrl+Z in the window undoes in the editor', `dimmer ${await dim()} (0.25 before the last release)`);
    await key('Control+Shift+Z');
    const redone = await until(async () => (Math.abs((await dim()) - 0.6) < 0.02 ? 1 : null), 4000);
    note(!!redone, 'Ctrl+Shift+Z redoes', `dimmer ${await dim()}`);
    const playing0 = await E(() => window.__showHost.get('session', 'isVideoPlaying'));
    await key('Space');
    const flipped = await until(async () => ((await E(() => window.__showHost.get('session', 'isVideoPlaying'))) !== playing0 ? 1 : null), 3000);
    await key('Space');
    const back = await until(async () => ((await E(() => window.__showHost.get('session', 'isVideoPlaying'))) === playing0 ? 1 : null), 3000);
    note(!!flipped && !!back, 'Space plays / pauses the editor\'s transport', `isVideoPlaying ${playing0} → ${!playing0} → ${playing0}`);
    const mtime0 = fs.statSync(project).mtimeMs;
    await key('Control+s');
    const saved1 = await until(async () => (fs.statSync(project).mtimeMs > mtime0 ? 1 : null), 6000);
    const onDisk = JSON.parse(fs.readFileSync(project, 'utf8'));
    const diskDim = (onDisk.fixtures.find((f) => f.id === 'fx_wash') || {}).dmx?.dimmer;
    note(!!saved1 && Math.abs(diskDim - 0.6) < 0.02, 'Ctrl+S in the window saves the project', `file rewritten: ${!!saved1}; dimmer on disk ${diskDim}`);
    await pc.evaluate(() => window.close());
    await sleep(800);

    console.log('\n10. a panel window is a workbench of its own: tabs, splits, and the way back');
    const pw2 = await openPanel('core.browser.groups');
    const W = (fn, ...a) => pw2.evaluate(fn, ...a);
    const tabs = () => W(() => [...document.querySelectorAll('[data-dock-tab]')].map((e) => e.getAttribute('data-dock-tab')));
    const activeTab = () => W(() => document.querySelector('[data-dock-tab][aria-selected="true"]')?.getAttribute('data-dock-tab') ?? null);
    const addVia = async (title) => {
      await W(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('title') === 'Add a panel here'); if (b) b.click(); });
      await sleep(300);
      return W((t) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t); if (b) b.click(); return !!b; }, title);
    };
    note(await addVia('Surfaces') && !!(await until(async () => ((await tabs()).includes('core.browser.surfaces') ? 1 : null), 3000)),
      'the "+" menu adds another detachable panel to the window, as a tab', JSON.stringify(await tabs()));
    // Back to the first tab, then ask the EDITOR for Surfaces: this window comes up on it, no new window.
    await W(() => document.querySelector('[data-dock-tab="core.browser.groups"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await sleep(300);
    const panelTargets = async () => (await browser.targets()).filter((t) => t.url().includes('panel.html')).length;
    const n0 = await panelTargets();
    await E(() => window.artlux.openPanelWindow('core.browser.surfaces'));
    const revealed = await until(async () => ((await activeTab()) === 'core.browser.surfaces' ? 1 : null), 4000);
    note(!!revealed && (await panelTargets()) === n0, 'asking for a panel that is already out brings its window up on that tab, and opens nothing new',
      `active tab ${await activeTab()}; panel windows ${n0} → ${await panelTargets()}`);
    // Split: the tab menu's "Split right".
    await W(() => document.querySelector('[data-dock-tab="core.browser.surfaces"]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 20 })));
    await sleep(300);
    await W(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Split right'); if (b) b.click(); });
    const split = await until(() => W(() => document.querySelectorAll('[data-dock-group]').length === 2), 3000);
    note(!!split, 'the tab menu splits the window', `${await W(() => document.querySelectorAll('[data-dock-group]').length)} groups`);
    const savedTrees = await until(async () => {
      const tr = (readPrefsNow().panelWindowTrees || {})['core.browser.groups'];
      return tr && JSON.stringify(tr).includes('core.browser.surfaces') && /"kind":"split"/.test(JSON.stringify(tr)) ? tr : null;
    }, 3000);
    note(!!savedTrees, "the window's arrangement is saved with it (per machine)");
    // Back to the editor: switch the editor to a workbench WITHOUT Global Params (Proj), add Global Params
    // to the window, then send it back. The editor's workbench must now hold it; the window must not.
    await E(() => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === 'Proj'); if (b) b.click(); });
    await sleep(1200);
    const inProj = () => E(() => {
      const L = window.__artluxWorkspaces.layout.get();
      return JSON.stringify((L.dockTrees || {})[L.activeContext] || null).includes('core.browser.globals');
    });
    const projBefore = await inProj();
    await addVia('Global Params');
    await until(async () => ((await activeTab()) === 'core.browser.globals' ? 1 : null), 3000);
    await W(() => {
      const t = document.querySelector('[data-dock-tab="core.browser.globals"]');
      t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 20 }));
    });
    await sleep(300);
    await W(() => { const b = [...document.querySelectorAll('button')].find((x) => /Back to the editor/.test(x.textContent || '')); if (b) b.click(); });
    const docked = await until(async () => ((await inProj()) ? 1 : null), 4000);
    const gone = await until(async () => (!(await tabs()).includes('core.browser.globals') ? 1 : null), 3000);
    note(!projBefore && !!docked && !!gone, '"Back to the editor" puts the panel into the editor\'s current workbench and takes it out of the window',
      `in Proj before ${projBefore}, after ${await inProj()}; window tabs ${JSON.stringify(await tabs())}`);
    await E(() => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === 'Map'); if (b) b.click(); });
    await sleep(800);

    console.log('\n11. the Show Host dies with a panel window open');
    // Watch the panel's replica at 50 Hz through the outage: it must never show an empty or default rig.
    await W(() => {
      window.__watch = { min: Infinity, sawDefault: false };
      window.__watchT = setInterval(() => {
        const f = window.__showHost.get('doc', 'fixtures') || [];
        window.__watch.min = Math.min(window.__watch.min, f.length);
        if (f.some((x) => x.name === 'Main Arch')) window.__watch.sawDefault = true;
      }, 20);
    });
    const oldPid = await E(() => window.__showHost.pid());
    try { execSync(`taskkill /PID ${oldPid} /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
    const newPid = await until(async () => { const p = await E(() => window.__showHost.pid()); return p && p !== oldPid ? p : null; }, 15000);
    const reconn = await until(() => W(() => window.__showHost.connected() && window.__showHost.pid() != null), 15000);
    await sleep(1500);
    const watch = await W(() => { clearInterval(window.__watchT); return window.__watch; });
    const edCount = (await edNames()).length;
    note(!!newPid && !!reconn, 'main forks a new host and the panel window reconnects to it', `host pid ${oldPid} → ${newPid}`);
    note(watch.min >= edCount && !watch.sawDefault, 'through the outage the panel never showed an empty or default document',
      `fewest fixtures seen ${watch.min} (the rig has ${edCount}); default rig seen: ${watch.sawDefault}`);
    await W(() => document.querySelector('[data-dock-tab="core.browser.groups"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const n1 = (await edNames()).length;
    // An edit after the restart, from the window, still runs in the editor and reaches the new host.
    await openPanel('core.browser.fixtures').then((p) => p.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('title') === 'Add Fixture'); if (b) b.click(); }));
    const grew2 = await until(async () => ((await edNames()).length === n1 + 1 ? 1 : null), 5000);
    const v2 = await E(() => window.__showHost.verify());
    note(!!grew2 && !!v2 && v2.mismatched.length === 0, 'after the restart an edit from a panel window still lands, and the new host agrees on every slice',
      `fixtures ${n1} → ${(await edNames()).length}; ${v2 ? `${v2.compared} slices compared` : 'no answer'}`);

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
    // Its ARRANGEMENT came back too: step 10 left the Groups window split, with Surfaces beside Groups.
    const gt = await browser.waitForTarget((x) => x.url().includes('panel.html?panel=core.browser.groups'), { timeout: 30000 }).catch(() => null);
    const gp = gt && await gt.page();
    const arr = gp && await until(() => gp.evaluate(() => {
      const ids = [...document.querySelectorAll('[data-dock-tab]')].map((e) => e.getAttribute('data-dock-tab'));
      const groups = document.querySelectorAll('[data-dock-group]').length;
      return ids.length ? { ids, groups } : null;
    }), 30000);
    note(!!arr && arr.groups === 2 && arr.ids.includes('core.browser.groups') && arr.ids.includes('core.browser.surfaces'),
      'it reopens with its own tabs and split', JSON.stringify(arr));
  } catch (e) {
    if (!e.done) {
      failures++;
      console.log(`\n\x1b[31mABORTED\x1b[0m ${e.message}`);
    }
  } finally {
    try { await browser?.disconnect(); } catch { /* gone */ }
    if (!KEEP) await stop(child);
    restorePrefs();
    if (!KEEP) try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* in use */ }
    console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : '\n\x1b[32mALL PASSED\x1b[0m');
    process.exit(failures ? 1 : 0);
  }
})();
