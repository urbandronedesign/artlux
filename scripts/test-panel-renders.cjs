// Runtime proof that a panel re-renders for ITS data only — the W2 property (plans/native-engine.md §9a).
//
//   node scripts/test-panel-renders.cjs [--keep]
//
// THE CLAIM. Before W2, every App render re-rendered every visible panel: the shell rendered registry
// panels inline, and panels read App's whole EditorData through one React context. W2 put a memo
// boundary around every registry panel (components/shell/PanelBody.tsx) and moved panels to
// useEditorPick(), which re-renders only when a field the panel NAMED changes. So a fixture edit must
// re-render the fixtures browser and must NOT re-render a panel that never reads fixtures.
//
// HOW IT COUNTS, WITHOUT TOUCHING THE APP. React reports every commit to
// window.__REACT_DEVTOOLS_GLOBAL_HOOK__ if one exists when React loads. This installs a minimal stand-in
// before the page loads (evaluateOnNewDocument + reload) and, per commit, walks the fiber tree counting
// function components that did work (the PerformedWork flag, or a fresh mount). Counts are by component
// NAME, which the dev build keeps. This is a structural assertion (did it render: yes/no), not a timing
// measurement — and it carries a POSITIVE control, so a counter that sees nothing cannot pass.
//
// The edit is the inspector's "Reverse Direction" checkbox: a pure fixture change that leaves the
// selection alone (a selection change legitimately re-renders every panel — `selection` is a PanelBody
// prop, because panels' applicability is decided by it).

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
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9385';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-panel-renders-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'panel-renders-test.artlux');
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
function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: 'ignore', shell: process.platform === 'win32' });
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

// The stand-in DevTools hook. Installed before React loads; counts renders per component name.
function installRenderCounter() {
  const counts = new Map();
  const nameOf = (t) => (t && (t.displayName || t.name)) || null;
  // WHICH FIBERS RENDERED IN THIS COMMIT. Not the PerformedWork flag alone: a subtree React bails out of
  // is NOT re-cloned, so its fibers sit in the committed tree with the flags of their LAST render, and a
  // flag-only count reported renders that never happened (it blamed SurfacesPanel for a fixture edit
  // that wrote no surfaces). React double-buffers: a fiber that rendered now is a DIFFERENT object from
  // the one committed last time. So: rendered = not in the previous committed tree AND (mounted OR did work).
  // ONE previous tree PER ROOT. React reports commits root by root, and the app has several (menus,
  // tooltips, modals): a single shared set was overwritten by another root's commit, after which every
  // untouched editor fiber looked new — the source of a SurfacesPanel count that varied 1–3 across runs
  // while an in-component log proved its body never ran.
  const prevTrees = new WeakMap();
  let prevTree = new WeakSet();
  let mounted = new Map();   // name -> instances present in the last committed tree
  let nextTree = null;
  const walk = (fiber) => {
    for (let f = fiber; f; f = f.sibling) {
      nextTree.add(f);
      if (f.tag === 0 || f.tag === 11 || f.tag === 15) { const mn = nameOf(f.type) || nameOf(f.elementType); if (mn) mounted.set(mn, (mounted.get(mn) || 0) + 1); }
      // FunctionComponent 0, ForwardRef 11, SimpleMemoComponent 15 — the kinds a panel is.
      if ((f.tag === 0 || f.tag === 11 || f.tag === 15) && !prevTree.has(f)) {
        // A fresh mount, or the component's BODY RAN: running a function component builds it a new hook
        // list, while a fiber React merely cloned past (a bailout) shares its alternate's list. The
        // PerformedWork flag alone over-counted — it reported SurfacesPanel ×2 for an edit during which
        // an in-component log proved its body never ran. (Components with no hooks fall back to props.)
        const did = f.alternate === null
          || (f.memoizedState !== null ? f.memoizedState !== f.alternate.memoizedState
                                       : f.memoizedProps !== f.alternate.memoizedProps);
        const n = nameOf(f.type) || nameOf(f.elementType);
        if (did && n) counts.set(n, (counts.get(n) || 0) + 1);
      }
      if (f.child) walk(f.child);
    }
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, isDisabled: false, renderers: new Map(),
    inject() { return 1; }, checkDCE() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      try {
        prevTree = prevTrees.get(root) || new WeakSet();
        nextTree = new WeakSet(); mounted = new Map();
        walk(root.current.child);
        prevTrees.set(root, nextTree);
      } catch { /* never break the app */ }
    },
  };
  window.__renderCounts = {
    reset() { counts.clear(); },
    read() { return Object.fromEntries(counts); },
    mounted() { return Object.fromEntries(mounted); },
  };
}

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
    // Install the counter BEFORE React loads: register it for the next document, then reload.
    await page.evaluateOnNewDocument(installRenderCounter);
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 60; i++) { if (await page.evaluate(() => !!window.__renderCounts && document.querySelectorAll('button').length > 3)) break; await sleep(1000); }
    await sleep(2500);
    await clickRail(page, 'Map');
    await sleep(1500);
    const hasCounter = await page.evaluate(() => !!window.__renderCounts && Object.keys(window.__renderCounts.read()).length > 0);
    note(hasCounter, 'the render counter sees React commits', hasCounter ? '' : 'no counts — the hook was not installed before React loaded');
    if (!hasCounter) throw new Error('no render counter');

    if (!(await clickRow(page, 'Strip 1'))) throw new Error('could not select Strip 1 — the project did not load after the reload');
    await sleep(1200);
    const before = await reverseBox(page);
    if (before === null) throw new Error('the inspector has no Reverse Direction checkbox for the selected strip');

    // A "did NOT re-render" check only means something for a panel that is ON SCREEN.
    const m = await page.evaluate(() => window.__renderCounts.mounted());
    note((m.FixturesPanel || 0) === 1 && (m.GlobalParamsPanel || 0) === 1 && (m.SurfacesPanel || 0) === 1,
      'the three panels under test are each mounted exactly once',
      `FixturesPanel ${m.FixturesPanel || 0} · GlobalParamsPanel ${m.GlobalParamsPanel || 0} · SurfacesPanel ${m.SurfacesPanel || 0}`);

    // ── the edit ────────────────────────────────────────────────────────────────────────────────
    await page.evaluate(() => window.__renderCounts.reset());
    await clickReverse(page);
    await sleep(1500);
    const after = await reverseBox(page);
    const c = await page.evaluate(() => window.__renderCounts.read());
    const n = (k) => c[k] || 0;
    console.log('\n1. a fixture edit (Reverse Direction) with the selection unchanged');
    note(after === !before, 'the edit landed', `reverse ${before} → ${after}`);
    note(n('FixturesPanel') > 0, 'POSITIVE CONTROL: the fixtures browser re-rendered', `FixturesPanel ×${n('FixturesPanel')}`);
    note(n('GlobalParamsPanel') === 0, 'the global params panel (reads brightness only) did NOT re-render', `GlobalParamsPanel ×${n('GlobalParamsPanel')}`);
    note(n('SurfacesPanel') === 0, 'the surfaces browser (reads surfaces only) did NOT re-render', `SurfacesPanel ×${n('SurfacesPanel')}`);
    const top = Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}×${v}`).join(' ');
    console.log(`        rendered in that edit: ${top}`);
  } catch (e) {
    failures++;
    console.error('\nharness error:', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    restorePrefs();
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
  console.log(failures ? `\n\x1b[31mpanel renders: ${failures} failure(s)\x1b[0m` : '\n\x1b[32mpanel renders OK — a panel re-renders for its own data only\x1b[0m');
  process.exitCode = failures ? 1 : 0;
})();
