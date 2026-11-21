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
//  12. The surface Content section in a window: every plugin source's settings from its UI half.
//  13. PLUGIN PANELS in a window (UI halves, runtime in the editor): Trigger Zones shows the editor's
//      occupancy and blobs live and its edits land in the editor; the OSC and Augmenta monitors see the
//      wire (main sends OSC to a window that listens) with the editor's settings; the Pose Monitor shows
//      the editor's engine status and says the picture is in the editor. Each stream detaches on close.
//  14. THE SHADER PANELS in a window, with the compile and the library the editor's: Ctrl+Enter on a
//      broken shader shows the editor GL context's error and writes nothing, on a good one writes the
//      surface; a help patch opened in Shader Nodes compiles (in the editor) and lands; Effects saves
//      the surface with a thumbnail rendered on the editor's GPU, lists it, and deletes it again.
//   7. Its place is remembered: reopened after a close it comes back at the same bounds; a window
//      pushed off every screen comes back ON one.
// Restores the whole prefs file, like every harness here (panel positions are written to it).

const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
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
// OSC for step 13, on a port of its own (a venue emitter on 10000 must not feed the test, nor the reverse).
// The listener is a MACHINE setting, so it goes into the prefs before launch — restored with the rest.
const OSC_PORT = 10477;
function enableOscInPrefs() {
  const p = readPrefsNow();
  p.appSettings = { ...(p.appSettings || {}), oscEnabled: true, oscListenPort: OSC_PORT, oscListenAddress: '' };
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2));
}
const sock = dgram.createSocket('udp4');
const padString = (str) => { const raw = Buffer.from(str, 'utf8'); const b = Buffer.alloc((Math.floor(raw.length / 4) + 1) * 4); raw.copy(b); return b; };
const oscPacket = (address, type, value) => {
  const arg = Buffer.alloc(4);
  if (type === 'i') arg.writeInt32BE(value | 0); else arg.writeFloatBE(value);
  return Buffer.concat([padString(address), padString(',' + type), arg]);
};
const fire = (address, type, value) => sock.send(oscPacket(address, type, value), OSC_PORT, '127.0.0.1');
// One person on SOL at (u,v) — the venue protocol (scripts/lidar-emitter.cjs); null empties the slot.
function sendBlob(p) {
  fire('/SOL/specs/Scalex', 'f', 5.825); fire('/SOL/specs/Scaley', 'f', 3.125);
  if (!p) { fire('/SOL/blobs/blob0/id', 'i', 0); return; }
  fire('/SOL/blobs/blob0/id', 'i', 1);
  fire('/SOL/blobs/blob0/tx', 'f', (p.u - 0.5) * 5.825); fire('/SOL/blobs/blob0/ty', 'f', (p.v - 0.5) * 3.125);
  fire('/SOL/blobs/blob0/u', 'f', p.u); fire('/SOL/blobs/blob0/v', 'f', p.v);
}
const ZONE = { id: 'zEntrance', name: 'Entrance', surface: 'SOL', u0: 0.05, v0: 0.55, u1: 0.32, v1: 0.95, color: '#f5a623', minBlobs: 1, enterSec: 0.2, exitSec: 0.4 };
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
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, trackingZones: [ZONE] },
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
  enableOscInPrefs();
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

    console.log('\n12. the surface Content section in its own window: plugin sources from their UI halves, the camera from the editor');
    await E(() => {
      const leaf = [...document.querySelectorAll('div[role="button"] *')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Wall 1');
      const row = leaf && leaf.closest('div[role="button"]');
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });
    await until(() => E(() => window.__showHost.get('session', 'selectedSurfaceId') === 'sf_wall'));
    const pcn = await openPanel('core.inspector.surface.content');
    const K = (fn, ...a) => pcn.evaluate(fn, ...a);
    const contentType = () => E(() => ((window.__showHost.get('doc', 'surfaces') || []).find((x) => x.id === 'sf_wall') || {}).content?.type);
    const pick = (label) => K((l) => {
      const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === l);
      if (b) b.click();
      return !!b;
    }, label);
    // NDI: a plugin with a UI half. Its picker is drawn in the window, from the plugin's ui.ts alone.
    const pickedNdi = await pick('NDI');
    const isNdi = await until(async () => ((await contentType()) === 'NDI' ? 1 : null), 5000);
    const ndiHere = await until(() => K(() => [...document.querySelectorAll('option')].some((o) => o.textContent === 'First source')), 5000);
    const ndiEditor = await E(() => [...document.querySelectorAll('option')].some((o) => o.textContent === 'First source'));
    note(pickedNdi && !!isNdi && !!ndiHere, "picking NDI in the window sets the editor's surface, and the window draws NDI's own source picker",
      `content ${await contentType()}; NDI picker in the window ${!!ndiHere}, in the editor ${ndiEditor}`);
    // SPOUT: its picker is the UI half's, and its "cannot run here" verdict is the editor RECEIVER's
    // (published as spout.status). The window's must match the editor's, whatever this PC answers.
    const pickedSpout = await pick('Spout');
    const isSpout = await until(async () => ((await contentType()) === 'SPOUT' ? 1 : null), 5000);
    const spoutHere = await until(() => K(() => [...document.querySelectorAll('option')].some((o) => o.textContent === 'Active sender')), 5000);
    await sleep(1500); // the editor's receiver starts and main gives its verdict
    const spoutWhy = (fn) => fn(() => { const m = document.body.innerText.match(/Spout not compatible\.[^\n]*/); return m ? m[0] : 'compatible'; });
    const whyHere = await spoutWhy(K);
    const whyEditor = await spoutWhy(E);
    note(pickedSpout && !!isSpout && !!spoutHere && whyHere === whyEditor,
      "Spout's picker is drawn in the window, with the editor receiver's verdict",
      `window "${whyHere}"; editor "${whyEditor}"`);
    // SHADER: the strongest probe — the GPU's name belongs to the editor's GL context, which a panel
    // window does not have. A window answering for itself would say "no name".
    await pick('Shader');
    const isShader = await until(async () => ((await contentType()) === 'SHADER' ? 1 : null), 5000);
    const gpuLine = (fn) => fn(() => { const m = document.body.innerText.match(/this one reports “([^”]*)”/); return m ? m[1] : null; });
    const gpuEditor = await until(() => gpuLine(E), 8000);
    const gpuHere = await until(async () => { const g = await gpuLine(K); return g && g !== 'no name' ? g : null; }, 8000);
    const detailHere = await K(() => [...document.querySelectorAll('label')].some((l) => (l.textContent || '').trim() === 'Detail'));
    note(!!isShader && detailHere && (gpuEditor == null ? gpuHere == null : gpuHere === gpuEditor),
      "the Shader settings are drawn in the window, with the editor's GPU (its GL context, not the window's)",
      `window "${gpuHere}", editor "${gpuEditor ?? '(discrete GPU: no ceiling line)'}"`);
    // TEXT: its settings, drawn without the rasterizer.
    await pick('Text');
    const isText = await until(async () => ((await contentType()) === 'TEXT' ? 1 : null), 5000);
    const fontRow = await until(() => K(() => /Font/.test(document.body.innerText) && /Line height/.test(document.body.innerText)), 5000);
    note(!!isText && !!fontRow, "the Text settings are drawn in the window (font, size, line height…)");
    const elsewhereAny = await K(() => document.querySelector('[data-content-elsewhere]')?.textContent || null);
    note(!elsewhereAny, 'no source in the window falls back to "set up in the editor" — every plugin has its UI half', elsewhereAny || '');
    // CAMERA: the inspector in the window asks the editor (services/cameraAccess → live/cameraRemote).
    await pick('Camera');
    const isCam = await until(async () => ((await contentType()) === 'CAMERA' ? 1 : null), 5000);
    const camLine = (fn) => fn(() => {
      const t = document.body.innerText;
      return /Live\./.test(t) ? 'live' : /Opening the camera/.test(t) ? 'opening' : /Retry/.test(t) ? 'error' : null;
    });
    const camHere = await until(() => K(() => [...document.querySelectorAll('label')].some((l) => (l.textContent || '').trim() === 'Device')), 5000);
    await sleep(2500); // the editor opens the capture; both inspectors poll at 500 ms
    const attachedCam = await E(() => window.__liveBroker.attached().includes('camera.info'));
    const stateHere = await camLine(K);
    const stateEditor = await camLine(E);
    const labelsHere = await K(() => [...document.querySelectorAll('select')][0] ? [...[...document.querySelectorAll('select')][0].options].slice(1).map((o) => o.textContent) : null);
    const labelsEditor = await E(async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d, i) => d.label || `Camera ${i + 1}`));
    note(!!isCam && !!camHere && attachedCam && stateHere != null && (stateEditor == null || stateHere === stateEditor),
      "the camera inspector in the window shows the editor's capture state, over the live channel",
      `window "${stateHere}", editor "${stateEditor ?? '(Content not docked in the editor)'}"; camera.info attached in the editor: ${attachedCam}`);
    note(JSON.stringify(labelsHere) === JSON.stringify(labelsEditor), "the device list is the editor's (labels and all)", `window ${JSON.stringify(labelsHere)}; editor ${JSON.stringify(labelsEditor)}`);
    const printsCam = await K(prints);
    note(!Object.values(printsCam).some(Boolean), 'the window still runs nothing: no transport, thumbnail cache, broker or three.js (the capture is the import-graph check)', JSON.stringify(printsCam));
    await pick('None');
    await until(async () => ((await contentType()) === 'NONE' ? 1 : null), 5000);
    await K(() => window.close());
    const detached = await until(() => E(() => !window.__liveBroker.attached().includes('camera.info')), 5000);
    note(!!detached, "closing the window stops the editor's camera poll for it (the stream detaches)");

    console.log('\n13. plugin panels in their own window: the runtime stays in the editor');
    const attachedNow = () => E(() => window.__liveBroker.attached());
    // TRIGGER ZONES. The zones are project data (the replica); occupancy, blobs and people are the
    // editor's zone engine's, over 'lidar-tracking.zoneView'.
    const pz = await openPanel('zone-editor');
    const Z = (fn, ...a) => pz.evaluate(fn, ...a);
    note(await Z(() => /Entrance/.test(document.body.innerText)), "Trigger Zones opens in a window and lists the project's zone", (await Z(() => document.title)));
    note(!Object.values(await Z(prints)).some(Boolean), 'the window runs no tracker, transport or engine of its own', JSON.stringify(await Z(prints)));
    const occupiedIcon = () => Z(() => {
      const row = [...document.querySelectorAll('button')].find((b) => /Entrance/.test(b.textContent || '') && /SOL/.test(b.textContent || ''));
      return !!row && !!row.parentElement && !!row.parentElement.querySelector('svg.text-warn');
    });
    // The editor shows its OWN Trigger Zones too (the 3D workbench, that dock tab in front): the same
    // panel, reading the same runtime through a local subscription — the docked half of one code path.
    const railTo = (label) => E((l) => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === l); if (b) b.click(); return !!b; }, label);
    await railTo('3D');
    await sleep(800);
    await E(() => { const t = document.querySelector('[data-dock-tab="zone-editor"]'); if (t) t.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await sleep(600);
    const edTally = () => E(() => { const b = [...document.querySelectorAll('button')].find((x) => /Zone in the centre/.test(x.textContent || '')); const c = b && b.closest('.h-full')?.querySelector('canvas'); return c ? (c.dataset.tally || null) : 'no zone map on screen'; });
    let holding = true;
    const holdLoop = (async () => { while (holding) { sendBlob({ u: 0.18, v: 0.75 }); await sleep(33); } })();
    const occ = await until(occupiedIcon, 8000);
    const tally = await until(() => Z(() => { const t = document.querySelector('canvas')?.dataset.tally; return t && /1 blobs/.test(t) ? t : null; }), 8000);
    const tallyEd = await until(async () => { const t = await edTally(); return t && /1 blobs/.test(t) ? t : null; }, 8000);
    holding = false; await holdLoop;
    note(!!tallyEd && tallyEd === tally, "…and the editor's own docked Trigger Zones shows the same tally (its local subscription)", `editor "${tallyEd ?? await edTally()}", window "${tally}"`);
    await railTo('Map');
    note(!!occ, "a person standing in the zone shows it OCCUPIED in the window (the editor's zone engine, live)");
    note(!!tally, "the map's tally is the editor's: the blob the tracker reported", tally || '(no tally)');
    const zAttached = (await attachedNow()).includes('lidar-tracking.zoneView');
    for (let i = 0; i < 20; i++) { sendBlob(null); await sleep(33); }
    const cleared = await until(async () => !(await occupiedIcon()), 8000);
    note(zAttached && !!cleared, '…and EMPTY again when they leave — the stream follows the room', `zoneView attached in the editor: ${zAttached}`);
    // An edit from the window: "+" adds a zone — in the editor, through the host's scene service.
    const zonesInEditor = () => E(() => ((window.__showHost.get('doc', 'scene3D') || {}).trackingZones || []).map((z) => z.name));
    const zBefore = (await zonesInEditor()).length;
    const added = await Z(() => { const b = [...document.querySelectorAll('button')].find((x) => /Zone in the centre/.test(x.textContent || '')); if (b) b.click(); return !!b; });
    const zAfter = await until(async () => { const n = await zonesInEditor(); return n.length === zBefore + 1 ? n : null; }, 6000);
    const zHere = zAfter && await until(() => Z((name) => document.body.innerText.includes(name), zAfter[zAfter.length - 1]), 6000);
    note(added && !!zAfter && !!zHere, 'a zone added in the window lands in the editor\'s project and comes back to the window', zAfter ? zAfter.join(', ') : `editor zones ${(await zonesInEditor()).join(', ')}`);
    await Z(() => window.close());
    note(!!(await until(async () => !(await attachedNow()).includes('lidar-tracking.zoneView'), 5000)), "closing it stops the editor's zone view for it (the stream detaches)");

    // OSC MONITOR: the wire itself — main sends OSC to a window that listens — and the editor's settings.
    const po = await openPanel('osc-monitor');
    const O = (fn, ...a) => po.evaluate(fn, ...a);
    const listening = await until(() => O((port) => document.body.innerText.includes(`:${port}`) && /listening/.test(document.body.innerText), OSC_PORT), 8000);
    note(!!listening, "the OSC Monitor in a window shows the editor's listener settings (listening on the test port)");
    let feeding = true;
    const feedLoop = (async () => { while (feeding) { sendBlob({ u: 0.6, v: 0.3 }); await sleep(40); } })();
    const seen = await until(() => O(() => /\/SOL\/blobs\/blob0\/u/.test(document.body.innerText)), 8000);
    feeding = false; await feedLoop;
    note(!!seen, 'it sees the OSC wire: the blob addresses arrive in the window');
    await O(() => window.close());

    // AUGMENTA MONITOR: the same wire, its own addresses.
    const pa = await openPanel('augmenta-monitor');
    const A = (fn, ...a) => pa.evaluate(fn, ...a);
    let auOn = true;
    const auLoop = (async () => { while (auOn) { fire('/au/scene/numPeople', 'i', 1); await sleep(40); } })();
    const au = await until(() => A(() => /\/au\/scene/.test(document.body.innerText) && /listening/.test(document.body.innerText)), 8000);
    auOn = false; await auLoop;
    note(!!au, 'the Augmenta Monitor in a window sees /au/ messages, with the listener settings');
    await A(() => window.close());

    // POSE MONITOR: the engine's status from the editor; the picture stays where the camera is.
    const pp = await openPanel('pose-monitor');
    const Q = (fn, ...a) => pp.evaluate(fn, ...a);
    const poseState = (fn) => fn(() => { const m = document.body.innerText.match(/status\s*\n\s*(idle|running|starting…|disabled)/i); return m ? m[1] : null; });
    const stHere = await until(() => poseState(Q), 8000);
    const pAttached = !!(await until(async () => (await attachedNow()).includes('mediapipe.monitor'), 5000));
    const noCam = await Q(() => /No camera/.test(document.body.innerText) || !!document.querySelector('[data-pose-picture-elsewhere]'));
    const noVideo = await Q(() => !document.querySelector('video'));
    note(!!stHere && pAttached && noCam && noVideo,
      "the Pose Monitor in a window shows the editor's engine status, and opens no camera of its own",
      `status "${stHere}"; mediapipe.monitor attached in the editor: ${pAttached}; video element here: ${!noVideo}`);
    await Q(() => window.close());
    note(!!(await until(async () => !(await attachedNow()).includes('mediapipe.monitor'), 5000)), "closing it stops the editor's pose status for it");

    console.log('\n14. the shader panels in their own window: the compile and the library are the editor\'s');
    // Wall 1 becomes a shader surface (the editor's own updateSurface, asked from a window's live client).
    const surfaceIn = () => E(() => (window.__showHost.get('doc', 'surfaces') || []).find((x) => x.id === 'sf_wall'));
    const psE = await openPanel('shader-editor');
    const SE = (fn, ...a) => psE.evaluate(fn, ...a);
    await SE(() => window.__liveClient.action('updateSurface', ['sf_wall', { content: { type: 'SHADER' } }]));
    await until(async () => (await surfaceIn())?.content?.type === 'SHADER', 5000);
    // Driven like an operator: click into the code, go to the end, type, Ctrl+Enter.
    const docText = () => SE(() => document.querySelector('.cm-content')?.textContent ?? null);
    const loaded = await until(async () => { const t = await docText(); return t && t.length > 20 ? t : null; }, 8000);
    note(!!loaded, 'the Shader editor opens in a window with the selected surface\'s code', loaded ? `${loaded.length} chars` : (await SE(() => document.body.innerText.slice(0, 160))));
    const chord = async (key) => { await psE.keyboard.down('Control'); await psE.keyboard.press(key); await psE.keyboard.up('Control'); };
    const ctrlEnter = () => chord('Enter');
    const typeAtEnd = async (text) => { await psE.click('.cm-content'); await chord('End'); await psE.keyboard.press('Enter'); await psE.keyboard.type(text); };
    const statusLine = () => SE(() => { const t = document.body.innerText; return /compiled — the surface is running this/.test(t) ? 'ok' : (t.match(/ERROR[^\n]*/) || [null])[0]; });
    if (loaded) {
      const srcBefore = (await surfaceIn()).content.shaderSource ?? null;
      await typeAtEnd('this is not glsl;');
      await ctrlEnter();
      const err = await until(async () => { const s = await statusLine(); return s && s !== 'ok' ? s : null; }, 8000);
      const unchanged = ((await surfaceIn()).content.shaderSource ?? null) === srcBefore;
      note(!!err && unchanged, "a broken shader shows the editor's compile error in the window, and nothing is written", err || '(no error shown)');
      // Undo the broken line in the editor's own history, then add a harmless one.
      for (let i = 0; i < 4 && /this is not glsl/.test((await docText()) || ''); i++) await chord('z');
      await typeAtEnd('// edited in a panel window');
      await ctrlEnter();
      const wrote = await until(async () => ((await surfaceIn()).content.shaderSource || '').includes('// edited in a panel window'), 8000);
      note(!!wrote && (await statusLine()) === 'ok', 'a good one compiles in the editor and is written to the surface');
    }
    note(!Object.values(await SE(prints)).some(Boolean), 'the window still runs nothing of its own: no transport, thumbnail cache, broker or three.js (no GL context is the import-graph check)', JSON.stringify(await SE(prints)));
    await SE(() => window.close());

    // SHADER NODES: a help patch, compiled by the editor, lands on the surface.
    const psN = await openPanel('shader-nodes');
    const SN = (fn, ...a) => psN.evaluate(fn, ...a);
    await until(() => SN(() => !!document.querySelector('.react-flow')), 8000);
    await SN(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Examples'); if (b) b.click(); });
    await sleep(300);
    const picked = await SN(() => { const b = [...document.querySelectorAll('button')].find((x) => /^1 · Coordinates are colour/.test((x.textContent || '').trim())); if (b) b.click(); return !!b; });
    // A non-empty graph asks first (the surface now has code): answer in the window's own dialog.
    await sleep(500);
    await SN(() => { const b = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((x) => /^(Replace|Open|Continue|OK)$/i.test((x.textContent || '').trim())); if (b) b.click(); });
    const graphLanded = await until(async () => { const g = (await surfaceIn()).content.shaderGraph; return g && /uv/i.test(g) ? 1 : null; }, 8000);
    const taught = await until(() => SN(() => /Every shader starts with UV/.test(document.body.innerText)), 5000);
    note(picked && !!graphLanded && !!taught, "a help patch opened in Shader Nodes in a window compiles in the editor and lands on the surface",
      `graph on the surface: ${!!graphLanded}; lesson shown: ${!!taught}`);
    await SN(() => window.close());

    // EFFECTS: save (thumbnail on the editor's GPU), listed in the window, then deleted — by its exact name.
    const psL = await openPanel('shader-library');
    const SL = (fn, ...a) => psL.evaluate(fn, ...a);
    await SL(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Save current'); if (b) b.click(); });
    const savedAs = await until(() => SL(() => (document.body.innerText.match(/Saved as “([^”]+)”/) || [null, null])[1]), 10000);
    const card = savedAs && await until(() => SL((n) => {
      const label = [...document.querySelectorAll('span[title]')].find((s) => s.getAttribute('title') === n);
      const img = label && label.closest('.group')?.querySelector('img');
      return img ? { thumb: (img.getAttribute('src') || '').startsWith('data:image/png') } : null;
    }, savedAs), 8000);
    note(!!savedAs && !!card && card.thumb, "Effects in a window saves the surface with a thumbnail from the editor's GPU, and lists it",
      `saved as ${savedAs}; card ${JSON.stringify(card)}`);
    if (savedAs) {
      await SL((n) => {
        const label = [...document.querySelectorAll('span[title]')].find((s) => s.getAttribute('title') === n);
        const x = label && label.parentElement.querySelector('button[title="Delete from the library"]');
        if (x) x.click();
      }, savedAs);
      await sleep(400);
      await SL((n) => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Delete'); if (b) b.click(); }, savedAs);
      const gone = await until(() => SL((n) => ![...document.querySelectorAll('span[title]')].some((s) => s.getAttribute('title') === n), savedAs), 8000);
      note(!!gone, '…and deletes it again (the editor\'s library, so this machine\'s library is as it was)', savedAs);
    }
    // The WINDOW's subscriptions (the editor's own docked Effects panel reads the same stream locally, so
    // the stream itself rightly stays attached): the window's client is there while open, gone after.
    const libClient = () => E(() => window.__liveBroker.clients().find((c) => /shader-library/.test(c.label)) || null);
    const libOpen = await libClient();
    await SL(() => window.close());
    const libGone = await until(async () => !(await libClient()), 5000);
    note(!!libOpen && libOpen.subs > 0 && !!libGone, "the window reads the editor's library over its own subscriptions, which go with the window",
      JSON.stringify({ open: libOpen, editorPanelsReading: await E(() => window.__liveBroker.locals()) }));
    await E(() => {}); // (Wall 1 stays a shader; nothing later depends on its content)

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
    try { sock.close(); } catch { /* closed */ }
    try { await browser?.disconnect(); } catch { /* gone */ }
    if (!KEEP) await stop(child);
    restorePrefs();
    if (!KEEP) try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* in use */ }
    console.log(failures ? `\n\x1b[31m${failures} FAILED\x1b[0m` : '\n\x1b[32mALL PASSED\x1b[0m');
    process.exit(failures ? 1 : 0);
  }
})();
