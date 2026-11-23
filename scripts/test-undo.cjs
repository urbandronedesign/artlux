// Runtime proof that UNDO / REDO restore the document — through the UI, in the real app.
//
//   node scripts/test-undo.cjs [--keep]
//
// WHY THIS EXISTS. The multi-window work (plans/native-engine.md §9a, E5/W1) moved every slice of the
// document out of App's useState into state/docStore.ts, and the selection / active scene / transport
// into a separate sessionStore. Undo (App's useHistory over DocSnapshot) was deliberately left where it
// was — but it now snapshots slices that live in a store and fans them back out through store setters,
// and NOTHING exercised that path: `npm run verify` reads source, and no harness pressed Ctrl+Z. This
// one does, on the three kinds of edit an operator undoes most, plus the property the session split
// exists to protect:
//
//   1. a fixture delete            undo brings it back, both redo chords remove it again
//   2. a selection click is NOT     delete → click other rows → ONE Ctrl+Z restores the delete
//      an undo step                (if a selection change pushed history, that Ctrl+Z would be eaten)
//   3. a timeline clip              add an Effect clip through the lane's "Add clip" menu → undo / redo
//   4. a new state                  "New state…" writes a scene AND a show-machine state in ONE step,
//                                   so one Ctrl+Z must remove both (a multi-slice snapshot)
//
// Everything is read off what an operator sees (browser rows, clip blocks, the pill's list), never off
// app internals. It builds its own project and launches with --project=, so lastProjectPath is never
// touched, and it restores the WHOLE prefs file afterwards (layout is persisted while it clicks).
//
// Plumbing is lifted from test-copy-paste.cjs (launch / rows / clickRow / press) and
// test-scene-timelines.cjs (drawer, lane right-click, clip reader); their comments carry the traps.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// PREFS GUARD — see test-copy-paste.cjs: the app persists layout while a test clicks around.
const PREFS_FILE = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const PREFS_BACKUP = (() => { try { return fs.readFileSync(PREFS_FILE); } catch { return null; } })();
function restorePrefs() {
  if (!PREFS_BACKUP) return;
  try { fs.writeFileSync(PREFS_FILE, PREFS_BACKUP); console.log('prefs restored'); }
  catch (e) { console.log(`prefs NOT restored (${e.message}) — backup was taken from ${PREFS_FILE}`); }
}

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9383';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-undo-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

// Two pixel strips on one surface, and a global timeline with one EMPTY layer (a lane to add a clip to).
// No scenes, so the editor is bound to the global timeline and "New state…" starts from zero.
function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'undo-test.artlux');
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
    timeline: {
      layers: [{ enabled: true, id: 'L1', name: 'Lane 1', height: 80 }], clips: [],
      duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false,
      trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [],
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: 'ignore', shell: process.platform === 'win32' });
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

// ── readers / drivers ────────────────────────────────────────────────────────────────────────────
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
const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('div[role="button"] *')]
    .filter((e) => e.children.length === 0).map((e) => (e.textContent || '').trim()).filter(Boolean));
const strips = async (page) => (await rows(page)).filter((r) => /^Strip \d+$/.test(r)).sort();
const press = async (page, key, mods = ['Control']) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  await sleep(700);
};
const undo = (page) => press(page, 'KeyZ');
const redoY = (page) => press(page, 'KeyY');
const redoShiftZ = (page) => press(page, 'KeyZ', ['Control', 'Shift']);
// Park the pointer over the left browser column: Delete yields to [data-owns-delete] under the pointer.
const parkPointer = (page) => page.mouse.move(120, 140);

const setDrawer = async (page, open) => {
  await page.evaluate((want) => {
    const b = document.querySelector('button[aria-controls="workspace-bottom"]');
    if (b && (b.getAttribute('aria-expanded') === 'true') !== want) b.click();
  }, open);
  await sleep(900);
};
const readClips = (page) => page.evaluate(() => [...document.querySelectorAll('div[title]')]
  .filter((e) => { const c = e.className || ''; return c.includes('top-1') && c.includes('bottom-1') && c.includes('rounded-sm'); })
  .map((e) => (e.getAttribute('title') || '').split(' — ')[0].trim()).filter(Boolean));
async function addEffectClip(page) {
  const spot = await page.evaluate(() => {
    const sc = [...document.querySelectorAll('div.overflow-auto')].find((d) => /Tracks/.test(d.innerText || ''));
    if (!sc) return null;
    const sr = sc.getBoundingClientRect();
    const row = [...sc.querySelectorAll('div')]
      .filter((d) => { const cs = (d.className || '').toString(); return /sticky/.test(cs) && /left-0/.test(cs) && d.querySelector('input'); })
      .map((d) => d.getBoundingClientRect())
      .find((r) => r.height > 12 && r.y > sr.y + 22 && r.y + Math.min(r.height, 26) < sr.bottom - 2);
    return row ? { x: Math.round(sr.x + 420), y: Math.round(row.y + Math.min(row.height, 26) / 2) } : null;
  });
  if (!spot) throw new Error('no track row found to right-click');
  await page.mouse.click(spot.x, spot.y, { button: 'right' });
  await sleep(600);
  const eff = await page.evaluate(() => {
    const menu = [...document.querySelectorAll('div.fixed')].find((d) => /add clip/i.test(d.innerText || ''));
    const b = menu && [...menu.querySelectorAll('button')].find((x) => (x.innerText || '').trim() === 'Effect');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!eff) throw new Error('"Add clip" menu with an Effect source did not open');
  await page.mouse.click(eff.x, eff.y);
  await sleep(800);
}
// The pill's dropdown lists Global + every scene; read the scene names, then close it again.
async function sceneNames(page) {
  const btn = await page.evaluate(() => {
    const b = document.querySelector('button[title="Choose which timeline to edit"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!btn) throw new Error('timeline pill not found');
  await page.mouse.click(btn.x, btn.y);
  await sleep(500);
  const names = await page.evaluate(() => {
    const g = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Global timeline');
    let box = g; while (box && !/New state/.test(box.textContent || '')) box = box.parentElement;
    if (!box) return null;
    // An entry is "● <name>  ▤ N clips": its FIRST span is the colour dot (no text), so take the first
    // span that has any — reading span[0] returned '' for every scene and made this whole step vacuous.
    const nameOf = (b) => ([...b.querySelectorAll('span')].map((s) => (s.textContent || '').trim()).find(Boolean) || '');
    return [...box.querySelectorAll('button')].map(nameOf)
      .filter((t) => t && t !== 'Global timeline' && !/New state/.test(t));
  });
  await page.keyboard.press('Escape');
  await sleep(400);
  return names;
}
async function clickNewState(page) {
  const btn = await page.evaluate(() => {
    const b = document.querySelector('button[title="Choose which timeline to edit"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(btn.x, btn.y);
  await sleep(500);
  const ns = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /New state/.test(x.textContent || ''));
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (!ns) throw new Error('"New state…" not found in the pill');
  await page.mouse.click(ns.x, ns.y);
  await sleep(1000);
}

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
    page.on('pageerror', (e) => console.log(`   [page-error] ${e.message}`));
    for (let i = 0; i < 40; i++) { if (await page.evaluate(() => document.querySelectorAll('button').length > 0)) break; await sleep(1000); }
    await clickRail(page, 'Map');
    await sleep(1500);
    await setDrawer(page, false);
    await parkPointer(page);

    // ── 1. fixture delete ────────────────────────────────────────────────────────────────────────
    console.log('\n1. undo / redo a fixture delete');
    note((await strips(page)).join(',') === 'Strip 1,Strip 2', 'the project opened with both strips', (await strips(page)).join(', '));
    if (!(await clickRow(page, 'Strip 2'))) throw new Error('could not select Strip 2');
    await press(page, 'Delete', []);
    note((await strips(page)).join(',') === 'Strip 1', 'Delete removed Strip 2', (await strips(page)).join(', '));
    await undo(page);
    note((await strips(page)).join(',') === 'Strip 1,Strip 2', 'Ctrl+Z brings it back', (await strips(page)).join(', '));
    await redoY(page);
    note((await strips(page)).join(',') === 'Strip 1', 'Ctrl+Y removes it again', (await strips(page)).join(', '));
    await undo(page);
    await redoShiftZ(page);
    note((await strips(page)).join(',') === 'Strip 1', 'Ctrl+Shift+Z is redo too', (await strips(page)).join(', '));
    await undo(page);
    note((await strips(page)).join(',') === 'Strip 1,Strip 2', 'and undo again restores it', (await strips(page)).join(', '));

    // ── 2. selection is session state, not history ───────────────────────────────────────────────
    console.log('\n2. a selection click is not an undo step');
    if (!(await clickRow(page, 'Strip 2'))) throw new Error('could not select Strip 2');
    await press(page, 'Delete', []);
    await clickRow(page, 'Strip 1');
    await clickRow(page, 'Wall 1');
    await clickRow(page, 'Strip 1');
    await parkPointer(page);
    await undo(page);
    note((await strips(page)).join(',') === 'Strip 1,Strip 2',
      'ONE Ctrl+Z after three selection clicks restores the delete',
      `${(await strips(page)).join(', ')} (a missing Strip 2 means a selection change pushed or consumed history)`);

    // ── 3. timeline clip ──────────────────────────────────────────────────────────────────────────
    console.log('\n3. undo / redo a timeline clip');
    await setDrawer(page, true);
    note((await readClips(page)).length === 0, 'the lane starts empty', JSON.stringify(await readClips(page)));
    await addEffectClip(page);
    note(JSON.stringify(await readClips(page)) === '["Effect"]', 'an Effect clip was added', JSON.stringify(await readClips(page)));
    await parkPointer(page);
    await undo(page);
    note((await readClips(page)).length === 0, 'Ctrl+Z removes the clip', JSON.stringify(await readClips(page)));
    await redoY(page);
    note(JSON.stringify(await readClips(page)) === '["Effect"]', 'Ctrl+Y puts it back', JSON.stringify(await readClips(page)));

    // ── 4. a new state: scene + show-machine state in ONE step ─────────────────────────────────────
    console.log('\n4. undo a new state (a scene and a machine state, one step)');
    const before = await sceneNames(page);
    note(Array.isArray(before) && before.length === 0, 'no states yet', JSON.stringify(before));
    await clickNewState(page);
    const made = await sceneNames(page);
    note(Array.isArray(made) && made.length === 1, '"New state…" created one', JSON.stringify(made));
    // Without a readable name the two checks below would pass on nothing — stop instead.
    if (!made || made.length !== 1) throw new Error('could not read the new state back — the rest of step 4 would be vacuous');
    // POSITIVE CONTROL for the machine-graph check below: the state must be visible there FIRST, or
    // "it is gone after undo" would pass on a reader that never sees states at all.
    const onGraph = async () => { await clickRail(page, 'Machine'); await sleep(1500); const v = await page.evaluate((n) => document.body.innerText.includes(n), made[0]); await clickRail(page, 'Map'); await sleep(1200); return v; };
    note(await onGraph(), 'the new state is drawn on the show-machine graph', made[0]);
    await parkPointer(page);
    await undo(page);
    const gone = await sceneNames(page);
    note(Array.isArray(gone) && gone.length === 0, 'ONE Ctrl+Z removes it', JSON.stringify(gone));
    // The show-machine half of the same snapshot: the Machine workbench must not still draw the state.
    const stillDrawn = await onGraph();
    note(!stillDrawn, 'and the show-machine state went with it', stillDrawn ? `"${made[0]}" is still on the graph` : '');
    // And the clip from step 3 survived the round trip (undo must not reach past what it was asked to).
    await setDrawer(page, true);
    note(JSON.stringify(await readClips(page)) === '["Effect"]', 'undoing the state did not touch the earlier clip', JSON.stringify(await readClips(page)));
  } catch (e) {
    failures++;
    console.error('\nharness error:', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    restorePrefs();   // after the app is dead, so nothing writes over it
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
  console.log(failures ? `\n\x1b[31mundo: ${failures} failure(s)\x1b[0m` : '\n\x1b[32mundo OK — the document comes back, and a selection is not history\x1b[0m');
  process.exitCode = failures ? 1 : 0;
})();
