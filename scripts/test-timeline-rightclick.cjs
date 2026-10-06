// WHAT A RIGHT-CLICK ANSWERS, on the body of every kind of timeline row.
//
//   node scripts/test-timeline-rightclick.cjs
//
// From the report that caused it: "when i clic right in on a track i should be able to see the osc
// track the color etc — for the moment some are missing." The menu was scoped to the 188px header
// column by x, so over most of the timeline's AREA a right-click did nothing, and the one surface
// that did answer (a video lane) offered clip sources and named no track kind.
//
// CDP, NOT HEADLESS, and screenshots at every step — the failures here are *a menu that renders
// behind the ruler*, *an entry that silently vanished* and *a panel that runs off the bottom of the
// screen*. None of those are visible to a source guard, and two of them are invisible to the DOM
// as well: the last one was found in a screenshot while `querySelector` reported every row present.
//
// FOUR TRAPS, each of which cost a run (see the memory note artlux-cdp-harness-traps):
//   · `Ctrl+T` TOGGLES, against a drawer whose toolbar stays in the DOM while collapsed. Press it
//     only while the toolbar is NOT hit-testable (elementFromPoint lands inside the button).
//   · Adding an OSC track OPENS ITS SETTINGS POPOVER. The next click then lands on that popover's
//     backdrop, not on the toolbar, and the run reads "the add menu did not open".
//   · "Maximize" is also the title of the workspace's panel-maximise button, which comes FIRST in
//     document order. Clicking it maximises a panel and leaves the drawer as it was.
//   · `innerText` is the RENDERED text: a header styled `uppercase` reads "ADD CLIP", so a
//     case-sensitive probe for "Add clip" finds nothing while the menu is plainly on screen.
//
// It builds its own project, and creates one row of every kind THROUGH THE UI rather than writing a
// persisted shape it would then have to keep in step.
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CDP = '9382';
const OUT = path.join(os.tmpdir(), 'artlux-rightclick-shots');
fs.mkdirSync(OUT, { recursive: true });
const WORK = path.join(os.tmpdir(), 'artlux-rightclick');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });
const puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core'));

function buildProject() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const lib = path.join(ROOT, 'resources', 'fixture-library');
  const all = fs.readdirSync(lib).filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'MANIFEST.json')
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(lib, f), 'utf8')));
  const prof = all.find((x) => x.id === 'generic/rgbw-4ch');
  const mode = prof.modes[0];
  const fixtures = [];
  for (let i = 0; i < 2; i++) fixtures.push({
    id: `fx${i}`, name: `Wash ${i + 1}`, x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0,
    universe: 0, startAddress: 1 + i * mode.footprint, ledCount: 1, reverse: false, colorData: [],
    profileId: prof.id, profileMode: mode.key,
    dmx: Object.fromEntries(prof.channels.map((c) => [c.key, 0])),
    position3D: { x: i - 0.5, y: 3, z: 0 }, controllerId: 'ctl',
  });
  const file = path.join(WORK, 'rows.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z', surfaces: [], fixtures,
    controllers: [{ id: 'ctl', name: 'Lighting', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1,
    groups: [{ id: 'grp', name: 'Front Wash', fixtureIds: fixtures.map((f) => f.id) }],
    scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50 },
    timeline: {
      layers: [{ id: 'lay0', name: 'Video 1', kind: 'video', color: '#4a90d9', enabled: true }],
      clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false,
      trackingTakes: [], lightingTakes: [], lightingSequences: [], colorLanes: [],
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

let failed = 0;
const note = (ok, what, detail) => { if (!ok) failed++; console.log(`   ${ok ? 'PASS ' : 'FAIL '} ${what}${detail ? ` — ${detail}` : ''}`); };

// The add-a-track menu, identified by what only it contains.
const addMenu = (page) => page.evaluate(() => {
  const box = [...document.querySelectorAll('div.fixed')].find((d) => /Video/.test(d.innerText || '') && /Automation/.test(d.innerText || '') && /Bed/.test(d.innerText || ''));
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return {
    rect: { x: Math.round(r.x), y: Math.round(r.y) },
    rows: [...box.querySelectorAll('button')].map((b) => {
      const br = b.getBoundingClientRect();
      return { text: (b.innerText || '').replace(/\s+/g, ' ').trim(), disabled: b.disabled, x: br.x + 8, y: br.y + br.height / 2 };
    }),
  };
});
const contentMenu = (page) => page.evaluate(() => {
  const box = [...document.querySelectorAll('div.fixed')].find((d) => /add clip/i.test(d.innerText || ''));
  if (!box) return null;
  const addTrack = [...box.querySelectorAll('button')].find((b) => /Add a track/.test(b.innerText || ''));
  const ar = addTrack ? addTrack.getBoundingClientRect() : null;
  return {
    text: (box.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    addTrack: ar ? { x: ar.x + 8, y: ar.y + ar.height / 2 } : null,
  };
});

(async () => {
  const file = buildProject();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP;
  const child = spawn('npm.cmd', ['run', 'dev', '--', '--', `--project=${file}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});

  let browser;
  try {
    let ver = null;
    for (let i = 0; i < 150 && !ver; i++) { try { ver = JSON.parse(await get(`http://127.0.0.1:${CDP}/json/version`)); } catch { await sleep(1000); } }
    if (!ver) throw new Error('app never came up on CDP');
    browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      for (const pg of await browser.pages()) {
        const u = pg.url();
        if (u.includes('splash.html') || u.includes('projector') || u.includes('docs.html')) continue;
        if (u.includes('localhost')) { page = pg; break; }
      }
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no editor window');
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(() => document.body.innerText.includes('FIXTURES')).catch(() => false)) break;
      await sleep(1000);
    }
    await sleep(4000);
    // Ctrl+T TOGGLES against a PERSISTENT element — press only while the toolbar is not hit-testable.
    const caretOf = () => page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Add a track of any kind/.test(x.title || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      if (r.width < 4 || r.bottom < 0 || r.top > window.innerHeight) return null;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!hit || !(b === hit || b.contains(hit))) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    for (let i = 0; i < 4 && !(await caretOf()); i++) {
      await page.keyboard.down('Control'); await page.keyboard.press('KeyT'); await page.keyboard.up('Control');
      await sleep(1800);
    }
    if (!(await caretOf())) throw new Error('the timeline drawer never opened — the toolbar is not hit-testable');
    // MAXIMISE, so every row is on screen at once. The drawer is ~250px: four rows fit, and a run that
    // only ever right-clicks what happens to be visible proves nothing about the colour row below it.
    // It is also the harder case for the popovers — maximised is a `fixed inset-0 z-50` stacking context.
    // ⚠ SCOPED TO THE TIMELINE'S OWN TOOLBAR. "Maximize" is also the title of the panel-maximise
    // button in the workspace above, it comes first in document order, and clicking it maximises a
    // PANEL while leaving the drawer exactly as it was — a pass that proves nothing. Pick the one in
    // the same row as the + Track caret.
    const maxBtn = await page.evaluate((cy) => {
      const b = [...document.querySelectorAll('button')]
        .filter((x) => /^Maximize/.test(x.title || ''))
        .find((x) => Math.abs(x.getBoundingClientRect().y + x.getBoundingClientRect().height / 2 - cy) < 20);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, (await caretOf()).y);
    if (maxBtn) { await page.mouse.click(maxBtn.x, maxBtn.y); await sleep(1200); }
    const caret = await caretOf();
    if (!caret) throw new Error('the toolbar is not hit-testable after maximising');
    await sleep(600);

    // Dismiss by clicking THE BACKDROP THAT IS THERE, at a point it certainly covers, and only
    // while one exists. A blind click at a screen corner is how you open the File menu by accident.
    // ⚠ Adding an OSC track OPENS ITS SETTINGS POPOVER — so the click after that one lands on a
    // backdrop, not on the toolbar. That cost two runs reading "the add menu did not open".
    const dismiss = async () => {
      for (let i = 0; i < 3; i++) {
        const bd = await page.evaluate(() => {
          const b = [...document.querySelectorAll('div.fixed')].find((d) => /inset-0/.test((d.className || '').toString()));
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return r.width > 200 && r.height > 200 ? { x: r.x + r.width / 2, y: r.y + r.height - 8 } : null;
        });
        if (!bd) return;
        await page.mouse.click(bd.x, bd.y);
        await sleep(350);
      }
    };
    // Build one row of every kind THROUGH THE UI, so the test does not depend on a persisted shape.
    const pick = async (re) => {
      await dismiss();
      await page.mouse.click(caret.x, caret.y); await sleep(900);
      let m = await addMenu(page);
      if (!m) {
        console.log('   diag:', JSON.stringify(await page.evaluate(() => ({
          caretTitles: [...document.querySelectorAll('button')].map((b) => b.title).filter((t) => t && /track/i.test(t)),
          fixedDivs: [...document.querySelectorAll('div.fixed')].map((d) => (d.innerText || '<empty>').replace(/\s+/g, ' ').slice(0, 80)),
        })), null, 1));
        await page.screenshot({ path: path.join(OUT, 'rc-FAIL.png') });
        throw new Error('the add menu did not open from the caret');
      }
      const row = m.rows.find((r) => re.test(r.text));
      if (!row) throw new Error(`no row matching ${re} — got ${m.rows.map((r) => r.text).join(' | ')}`);
      await page.mouse.click(row.x, row.y); await sleep(900);
      return m;
    };
    console.log('\n0. build one row of every kind');
    await pick(/^OSC/);
    await pick(/^Audio/);
    await pick(/^Colour/);
    const sub = await page.evaluate(() => {
      const box = [...document.querySelectorAll('div.fixed')].find((d) => /Front Wash/.test(d.innerText || ''));
      const b = box && [...box.querySelectorAll('button')].find((x) => /Front Wash/.test(x.innerText || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + 8, y: r.y + r.height / 2 };
    });
    if (!sub) throw new Error('the colour submenu did not list the group');
    await page.mouse.click(sub.x, sub.y); await sleep(1400);
    await dismiss();
    const rows = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('div.overflow-auto')].find((d) => /Tracks/.test(d.innerText || ''));
      return (sc ? sc.innerText : '').replace(/\n+/g, ' | ').slice(0, 300);
    });
    console.log('   rows now:', rows);

    // EVERY ROW HAS A STICKY GUTTER CELL — that is the reliable handle on a row, where matching a
    // label is not: a track name lives in an input's VALUE, and a colour row's label sits inside a
    // button next to an icon. Enumerating the gutter cells gives the real y bands, in order.
    const rowBands = () => page.evaluate(() => {
      const sc = [...document.querySelectorAll('div.overflow-auto')].find((d) => /Tracks/.test(d.innerText || ''));
      const sr = sc.getBoundingClientRect();
      return [...sc.querySelectorAll('div')]
        .filter((d) => { const cs = (d.className || '').toString(); return /sticky/.test(cs) && /left-0/.test(cs); })
        .map((d) => {
          const r = d.getBoundingClientRect();
          const inputs = [...d.querySelectorAll('input')].map((i) => i.value).filter(Boolean);
          return {
            label: ([...inputs, (d.innerText || '').replace(/\s+/g, ' ').trim()].join(' ') || '?').slice(0, 34),
            y: Math.round(r.y), h: Math.round(r.height),
            bodyX: Math.round(sr.x + 420), bodyY: Math.round(r.y + Math.min(r.height, 26) / 2),
          };
        })
        .filter((b) => b.h > 12 && b.y > sr.y + 22 && b.y + Math.min(b.h, 26) < sr.bottom - 2);
    });
    // WHICH menu answered, if any.
    const whichMenu = async () => {
      if (await addMenu(page)) return 'add';
      if (await contentMenu(page)) return 'content';
      return 'none';
    };

    console.log(''); console.log('1. right-click the BODY of every row');
    const bands = await rowBands();
    console.log(`   ${bands.length} rows: ${bands.map((b) => b.label).join(' / ')}`);
    note(bands.length >= 4, 'the timeline really has a row of every kind', `${bands.length} rows`);
    let dead = [];
    for (const b of bands) {
      await dismiss();
      await page.mouse.click(b.bodyX, b.bodyY, { button: 'right' });
      await sleep(650);
      const got = await whichMenu();
      const c = got === 'content' ? await contentMenu(page) : null;
      console.log(`   ${got === 'none' ? 'FAIL ' : 'PASS '} “${b.label}” body → ${got}${c && c.addTrack ? ' (+ Add a track)' : ''}`);
      if (got === 'none') { dead.push(b.label); failed++; }
      if (got === 'content') note(!!c.addTrack, `   and the picker on “${b.label}” names the other verb`, c.addTrack ? 'Add a track' : 'MISSING');
      await page.screenshot({ path: path.join(OUT, `rc-row-${bands.indexOf(b)}.png`) });
    }
    note(dead.length === 0, 'no row answers a right-click with nothing', dead.length ? `dead: ${dead.join(', ')}` : 'all rows answer');

    console.log(''); console.log('2. the empty space below the last track');
    await dismiss();
    const below = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('div.overflow-auto')].find((d) => /Tracks/.test(d.innerText || ''));
      const sr = sc.getBoundingClientRect();
      const wrap = sc.firstElementChild.getBoundingClientRect();
      // only honest if the content really ends above the scroller's bottom
      return wrap.bottom < sr.bottom - 16 ? { x: sr.x + 520, y: (wrap.bottom + sr.bottom) / 2 } : null;
    });
    if (below) {
      await page.mouse.click(below.x, below.y, { button: 'right' }); await sleep(700);
      note((await whichMenu()) === 'add', 'the empty space below the last track → the add-a-track menu');
      await page.screenshot({ path: path.join(OUT, 'rc-below.png') });
    } else { console.log('   (the rows fill the scroller — no empty space to test)'); }

    console.log(''); console.log('3. the gutter still answers, and the menu is still complete');
    await dismiss();
    const gut = await page.evaluate(() => {
      const el = [...document.querySelectorAll('div')].find((d) => /^Tracks/.test(d.innerText || ''));
      const r = el.getBoundingClientRect();
      return { x: r.x + 60, y: r.y + 120 };
    });
    await page.mouse.click(gut.x, gut.y, { button: 'right' }); await sleep(700);
    const a3 = await addMenu(page);
    note(!!a3, 'the header column → the add-a-track menu', a3 ? `at ${a3.rect.x},${a3.rect.y}` : 'not found');
    const kinds = a3 ? a3.rows.map((r) => r.text) : [];
    for (const k of ['Video', 'Automation', 'OSC', 'Colour', 'Audio', 'Bed']) {
      note(kinds.some((t) => t.startsWith(k)), `  ${k} is listed`, kinds.find((t) => t.startsWith(k)) || 'ABSENT');
    }

    console.log(''); console.log('4. from the clip picker, one step to the track kinds');
    await dismiss();
    const vidBand = (await rowBands()).find((b) => /Video/.test(b.label));
    if (vidBand) {
      await page.mouse.click(vidBand.bodyX, vidBand.bodyY, { button: 'right' }); await sleep(700);
      const c2 = await contentMenu(page);
      note(!!c2 && !!c2.addTrack, 'the picker offers Add a track');
      if (c2 && c2.addTrack) {
        await page.mouse.click(c2.addTrack.x, c2.addTrack.y); await sleep(700);
        const a4 = await addMenu(page);
        note(!!a4, 'and it opens the full menu', a4 ? `${a4.rows.length} rows` : 'did not open');
        note(!(await contentMenu(page)), 'the picker closed behind it');
        await page.screenshot({ path: path.join(OUT, 'rc-twostep.png') });
      }
    } else { note(false, 'the video row was findable'); }

    // ── THE MODE IT SHIPS IN ──────────────────────────────────────────────────────────────────
    // Maximised is the easy case for a tall popover. The drawer is ~250px at the BOTTOM of the
    // window, which is where a lane actually gets right-clicked — and there the picker opened at
    // y≈700 and ran past the bottom of the screen, so the row this change adds was rendered,
    // hit-testable, and impossible to see. Restore and assert the panel is ON SCREEN.
    console.log(''); console.log('5. and in the DRAWER, where the lanes really are');
    await dismiss();
    const restore = await page.evaluate((cy) => {
      const b = [...document.querySelectorAll('button')]
        .filter((x) => /^Restore/.test(x.title || ''))
        .find((x) => Math.abs(x.getBoundingClientRect().y + x.getBoundingClientRect().height / 2 - cy) < 20);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, caret.y);
    note(!!restore, 'the timeline can be restored to the drawer');
    if (restore) {
      await page.mouse.click(restore.x, restore.y); await sleep(1200);
      const vb = (await rowBands()).find((b) => /Video/.test(b.label));
      note(!!vb, 'the video lane is in the drawer');
      if (vb) {
        await page.mouse.click(vb.bodyX, vb.bodyY, { button: 'right' }); await sleep(800);
        const fit = await page.evaluate(() => {
          const box = [...document.querySelectorAll('div.fixed')].find((d) => /add clip/i.test(d.innerText || ''));
          if (!box) return null;
          const r = box.getBoundingClientRect();
          const row = [...box.querySelectorAll('button')].find((b) => /Add a track/.test(b.innerText || ''));
          const rr = row ? row.getBoundingClientRect() : null;
          const hit = rr ? document.elementFromPoint(rr.x + 20, rr.y + rr.height / 2) : null;
          return {
            panel: `${Math.round(r.y)}..${Math.round(r.bottom)} of ${window.innerHeight}`,
            onScreen: r.bottom <= window.innerHeight + 1 && r.y >= 0,
            rowReachable: !!rr && !!hit && (row === hit || row.contains(hit)),
          };
        });
        note(!!fit, 'the picker opened in the drawer');
        if (fit) {
          note(fit.onScreen, 'the whole picker is on screen', fit.panel);
          note(fit.rowReachable, 'and "Add a track" is hit-testable, not merely rendered');
        }
        await page.screenshot({ path: path.join(OUT, 'rc-drawer.png') });
      }
    }
  } catch (e) {
    failed++;
    console.error('harness error:', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* */ }
    try { child.kill('SIGKILL'); } catch { /* */ }
    try { execSync('taskkill /IM electron.exe /F /T', { stdio: 'ignore' }); } catch { /* */ }
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nright-click OK');
})();
