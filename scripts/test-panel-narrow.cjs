#!/usr/bin/env node
// EVERY DETACHABLE PANEL FITS A NARROW WINDOW (E5). A panel window opens 380 px wide (main/panelWindows.ts
// DEFAULT_SIZE) and can be dragged down to 240, while most panels were laid out for the editor's docks —
// a 16rem column beside a map, a toolbar row that does not wrap. The packaged-app check found the first
// one by eye (Trigger Zones printed "Zones 1" on top of its surface picker); this finds the rest by rule.
//
// For each detachable panel (with a selection it applies to, for the inspector sections) it opens the
// panel in its own window, sets the page to each WIDTH, and asks the page two questions:
//   SPILL   — a visible leaf (text, a control, an image/canvas) whose box passes the right edge of what
//             clips it, or of the window, where the operator cannot scroll to it. Text cut with an
//             ellipsis (`truncate`) is a choice, not a spill; a box inside a horizontal scroller is
//             reachable, and reported separately as SCROLL only at the default width.
//   OVERLAP — two visible text/control leaves whose boxes intersect (neither inside the other): text
//             printed over text, the Trigger Zones defect.
// Each panel is also screenshotted, because a rule only sees what it was written for.
//
//   node scripts/test-panel-narrow.cjs                 all panels, widths 380 and 280
//   node scripts/test-panel-narrow.cjs zone-editor     one panel
// Dev mode + CDP (it reads layout, not window visibility: that is the packaged check). Win32 only like
// test-panel-window; restores the prefs file. Screenshots go to %TEMP%/artlux-panel-narrow.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PREFS_FILE = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const PREFS_BACKUP = (() => { try { return fs.readFileSync(PREFS_FILE); } catch { return null; } })();
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9389';
const WORK = path.join(os.tmpdir(), 'artlux-panel-narrow');
const MAIN_LOG = path.join(WORK, 'main.log');
const WIDTHS = [380, 280];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

// Which selection a panel needs to show its real content (the inspector sections; everything else: none).
const PIXEL = 'Strip Alpha', LIGHT = 'Wash Q4', SURFACE = 'Wall 1';
const PANELS = [
  ['core.browser.surfaces'], ['core.browser.fixtures'], ['core.browser.groups'], ['core.browser.globals'],
  ['core.inspector.surface.content', SURFACE], ['core.inspector.surface.transform', SURFACE],
  ['core.inspector.fixture.profile', LIGHT], ['core.inspector.fixture.channels', LIGHT],
  ['core.inspector.fixture.patch', PIXEL], ['core.inspector.fixture.mapping', PIXEL],
  ['core.inspector.fixture.segments', PIXEL], ['core.inspector.fixture.output', PIXEL],
  ['core.inspector.fixture.routing', PIXEL], ['core.inspector.fixture.layout3d', PIXEL],
  ['core.inspector.fixture.position', LIGHT],
  ['core.browser.timing'], ['core.dock.monitor'], ['core.dock.perf'], ['core.dock.fixtureLibrary'],
  ['core.dock.fixtureWiring', PIXEL], ['core.dock.routing'],
  ['core.browser.models'], ['core.browser.scene3dFixtures'], ['core.inspector.model.transform'],
  ['core.inspector.fixture.arrange', PIXEL], ['core.inspector.scene.lighting'], ['core.inspector.scene.tracking'],
  ['core.viewport.machine'], ['core.dock.lightingTakes'], ['core.dock.trackingTakes'],
  ['core.browser.media'], ['core.dock.media'], ['core.viewport.preferences'],
  ['augmenta-monitor'], ['osc-monitor'], ['zone-editor'], ['pose-monitor'],
  ['shader-editor'], ['shader-nodes'], ['shader-library'],
];
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const todo = only.length ? PANELS.filter(([id]) => only.includes(id)) : PANELS;

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'panel-narrow-test.artlux');
  const strip = (id, name, y, addr) => ({
    id, name, x: 0.1, y, width: 0.5, height: 0.04, rotation: 0,
    universe: 0, startAddress: addr, ledCount: 30, reverse: false, colorData: [], surfaceId: 'sf_wall', controllerId: 'ctl',
  });
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [{ id: 'sf_wall', name: SURFACE, x: 0.05, y: 0.05, width: 0.9, height: 0.9, rotation: 0, zIndex: 0, content: { type: 'NONE' } }],
    fixtures: [strip('fx_a', PIXEL, 0.2, 1), strip('fx_b', 'Strip Bravo', 0.4, 91),
      { id: 'fx_wash', name: LIGHT, x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0, universe: 0, startAddress: 300, ledCount: 1, reverse: false, colorData: [],
        profileId: 'american-dj/inno-pocket-beam-q4', profileMode: '13ch', controllerId: 'ctl', position3D: { x: 0, y: 4, z: 0 },
        dmx: { dimmer: 1, pan: 0.5, tilt: 0.5, red: 1, green: 0, blue: 0, white: 0 } }],
    controllers: [{ id: 'ctl', name: 'Main', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0 }],
    globalBrightness: 1, groups: [{ id: 'g1', name: 'Both strips', fixtureIds: ['fx_a', 'fx_b'] }], scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false,
      trackingZones: [{ id: 'zEntrance', name: 'Entrance', surface: 'SOL', u0: 0.05, v0: 0.55, u1: 0.32, v1: 0.95, color: '#f5a623', minBlobs: 1, enterSec: 0.2, exitSec: 0.4 }] },
    timeline: { layers: [], clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [] },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}
// No remembered panel windows: each opens at the default size, and none reopens on launch.
function cleanPrefs() {
  let p = {}; try { p = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { /* fresh */ }
  delete p.openPanelWindows; delete p.panelWindows; delete p.panelWindowTrees;
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2));
}
function restorePrefs() {
  if (!PREFS_BACKUP) return;
  try { fs.writeFileSync(PREFS_FILE, PREFS_BACKUP); console.log('prefs restored'); }
  catch (e) { console.log(`prefs NOT restored (${e.message}) — backup was taken from ${PREFS_FILE}`); }
}
function launch(project) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  const fd = fs.openSync(MAIN_LOG, 'w');
  return spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '--', '--', `--project=${project}`],
    { cwd: ROOT, env, stdio: ['ignore', fd, fd], shell: process.platform === 'win32' });
}
async function stop(child) {
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  try { execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none */ }
  await sleep(2000);
}
const until = async (fn, ms = 8000, step = 200) => {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); }
};

// Runs IN the panel page. Returns { spill: [...], overlap: [...], scroll: [...] } as short descriptions.
function inspectLayout() {
  const W = document.documentElement.clientWidth;
  const desc = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `<${el.tagName.toLowerCase()}>${t ? ` "${t}"` : ''}`;
  };
  const visible = (el, r) => {
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  // A leaf: a control, a media box, or an element that owns text directly.
  const isLeaf = (el) => {
    if (/^(INPUT|SELECT|TEXTAREA|BUTTON|CANVAS|IMG|SVG|VIDEO)$/i.test(el.tagName)) return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true;
    return false;
  };
  const insideControl = (el) => !!el.parentElement?.closest('button, select, svg, [role="button"]');
  const ellipsis = (el) => { const s = getComputedStyle(el); return s.textOverflow === 'ellipsis' && s.overflowX !== 'visible'; };
  const leaves = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!isLeaf(el) || insideControl(el)) continue;
    // A box the operator cannot see at all (a closed <details>, a collapsed section) is not a defect.
    if (el.closest('[hidden], [aria-hidden="true"]')) continue;
    const r0 = el.getBoundingClientRect();
    if (!visible(el, r0)) continue;
    // What is actually IN VIEW: the box cut by every ancestor that scrolls VERTICALLY (a list's rows
    // scrolled under its footer are not on screen). Horizontal clipping is what SPILL is about, so the
    // box keeps its full width here.
    const r = { left: r0.left, right: r0.right, top: r0.top, bottom: r0.bottom };
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (getComputedStyle(a).overflowY === 'visible') continue;
      const c = a.getBoundingClientRect();
      r.top = Math.max(r.top, c.top); r.bottom = Math.min(r.bottom, c.bottom);
    }
    if (r.bottom - r.top < 2) continue;
    // Off the bottom is what vertical scrolling is for; only what is (partly) in view counts.
    if (r.bottom < 0 || r.top > document.documentElement.clientHeight + 2000) continue;
    leaves.push({ el, r });
  }
  const spill = [], scroll = [], overlap = [];
  for (const { el, r } of leaves) {
    if (ellipsis(el)) continue;
    // The nearest ancestor that clips horizontally decides: a scroller makes it reachable, a clipper cuts it.
    let a = el.parentElement, clip = null, scroller = false;
    while (a && a !== document.documentElement) {
      const s = getComputedStyle(a);
      if (s.overflowX !== 'visible') { clip = a; scroller = /auto|scroll/.test(s.overflowX) && a.scrollWidth > a.clientWidth + 1; break; }
      a = a.parentElement;
    }
    const right = clip ? Math.min(clip.getBoundingClientRect().right, W) : W;
    const left = clip ? Math.max(clip.getBoundingClientRect().left, 0) : 0;
    if (r.right > right + 1.5 || r.left < left - 1.5) (scroller ? scroll : spill).push(`${desc(el)} ${Math.round(r.left)}..${Math.round(r.right)} past ${Math.round(left)}..${Math.round(right)}`);
  }
  // Text over text: two leaves intersecting by more than a sliver, neither containing the other. A
  // positioned overlay (a badge over a thumbnail, a label on a canvas) is meant to sit on top: skip
  // leaves whose nearest positioned context is absolute/fixed over a canvas or image.
  const textish = leaves.filter(({ el }) => !/^(CANVAS|IMG|SVG|VIDEO)$/i.test(el.tagName));
  for (let i = 0; i < textish.length; i++) {
    for (let j = i + 1; j < textish.length; j++) {
      const A = textish[i], B = textish[j];
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      // A label drawn INSIDE a field on purpose (the X / Y / Z of a number field): an absolutely
      // positioned, pointer-transparent leaf over a control.
      const overlay = (x) => { const s = getComputedStyle(x); return s.position === 'absolute' && s.pointerEvents === 'none'; };
      const control = (x) => /^(INPUT|SELECT|TEXTAREA)$/i.test(x.tagName);
      if ((overlay(A.el) && control(B.el)) || (overlay(B.el) && control(A.el))) continue;
      const w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
      const h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
      if (w > 3 && h > 3) overlap.push(`${desc(A.el)} × ${desc(B.el)}`);
    }
  }
  const uniq = (xs) => [...new Set(xs)].slice(0, 8);
  return { spill: uniq(spill), scroll: uniq(scroll), overlap: uniq(overlap) };
}

(async () => {
  if (!puppeteer) { console.error('puppeteer-core not installed — run npm install'); process.exit(1); }
  fs.mkdirSync(WORK, { recursive: true });
  const project = buildProject();
  cleanPrefs();
  const child = launch(project);
  let browser = null;
  let bad = 0;
  const report = [];
  try {
    let up = null;
    for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { /* not yet */ } }
    if (!up) throw new Error('the app never opened its CDP port');
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null });
    let ed = null;
    for (let i = 0; i < 40 && !ed; i++) {
      ed = (await browser.pages()).find((p) => /localhost:3000\/?(index\.html)?(\?|$)/.test(p.url())) || null;
      if (!ed) await sleep(1000);
    }
    if (!ed) throw new Error('no editor page');
    const E = (fn, ...a) => ed.evaluate(fn, ...a);
    for (let i = 0; i < 90; i++) { if (await E(() => document.querySelectorAll('button').length > 3 && !!window.__showHost?.connected()).catch(() => false)) break; await sleep(1000); }
    await sleep(2500);
    await E(() => { const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === 'Map'); if (b) b.click(); });
    await sleep(1200);
    const select = async (name) => {
      // A row in the editor's own outliners (Surfaces / Fixtures), as the operator would.
      await E((n) => {
        const leaf = [...document.querySelectorAll('div[role="button"] *')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === n);
        leaf?.closest('div[role="button"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }, name);
      await sleep(600);
    };

    for (const [id, sel] of todo) {
      if (sel) await select(sel);
      await E((pid) => window.artlux.openPanelWindow(pid), id);
      const t = await browser.waitForTarget((x) => x.url().includes(`panel.html?panel=${encodeURIComponent(id)}`), { timeout: 20000 }).catch(() => null);
      if (!t) { console.log(`\x1b[31mFAIL\x1b[0m ${id}: no window`); bad++; continue; }
      const p = await t.page();
      await until(() => p.evaluate(() => !!window.__showHost && window.__showHost.ready() && !/Connecting/.test(document.body.innerText)), 30000);
      await sleep(1500);   // the panel's own first paint, lazy chunks, a live stream's first frame
      const lines = [];
      for (const w of WIDTHS) {
        await p.setViewport({ width: w, height: 620 });
        await sleep(500);
        const r = await p.evaluate(inspectLayout);
        await p.screenshot({ path: path.join(WORK, `${id}@${w}.png`) });
        const n = r.spill.length + r.overlap.length;
        if (n) bad++;
        lines.push(`  @${w}: ${n ? '\x1b[31m' + n + ' problem(s)\x1b[0m' : '\x1b[32mok\x1b[0m'}${w === WIDTHS[0] && r.scroll.length ? ` (${r.scroll.length} in a horizontal scroller)` : ''}`);
        for (const s of r.spill) lines.push(`      SPILL   ${s}`);
        for (const s of r.overlap) lines.push(`      OVERLAP ${s}`);
        if (w === WIDTHS[0]) for (const s of r.scroll) lines.push(`      scroll  ${s}`);
      }
      console.log(`${id}${sel ? ` (with ${sel})` : ''}\n${lines.join('\n')}`);
      report.push({ id, lines });
      await p.evaluate(() => window.close()).catch(() => {});
      await sleep(400);
    }
  } catch (e) {
    console.error('harness error:', e.message);
    bad++;
  } finally {
    try { await browser?.disconnect(); } catch { /* gone */ }
    await stop(child);
    restorePrefs();
    console.log(`\n${bad ? `\x1b[31m${bad} panel/width(s) with problems\x1b[0m` : '\x1b[32mevery panel fits\x1b[0m'} — screenshots in ${WORK}`);
    process.exit(bad ? 1 : 0);
  }
})();
