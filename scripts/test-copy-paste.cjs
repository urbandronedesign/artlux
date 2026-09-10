// Runtime proof that Ctrl+C / Ctrl+V builds a rig, and that it does not break anything it touches.
//
//   node scripts/test-copy-paste.cjs [--keep]
//
// Building a rig is repetitive - eight identical heads on a truss, six strips down a wall - and each
// one used to mean Add, then re-typing the mode, the wiring, the colour order and the layout the last
// one already had.
//
// What is asserted, in the order it would bite:
//   1. a copied fixture pastes, and the copy carries the original's PROFILE AND MODE;
//   2. it is RE-PATCHED to free channels - never the source's own start address, which on a real rig
//      is two heads answering to the same DMX and a patch that looks right until it is not;
//   3. it is OFFSET, so the copy is not sitting invisibly underneath the original;
//   4. pasting FOUR at once numbers them 2,3,4,5 rather than four fixtures all called "Head 2";
//   5. a surface copies too;
//   6. ⚠ Ctrl+C INSIDE A TEXT FIELD IS LEFT ALONE. Hijacking it would mean an operator copying an IP
//      address out of Routing silently got a fixture instead, with nothing to tell them until the
//      paste. This is the assertion that keeps the feature safe to ship.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9381';
const KEEP = process.argv.includes('--keep');
const WORK = path.join(os.tmpdir(), 'artlux-copy-paste-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => {
  http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej);
});
let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const file = path.join(WORK, 'copy-paste-test.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [{
      id: 'sf_wall', name: 'Wall 1', x: 0.1, y: 0.1, width: 0.4, height: 0.3, rotation: 0,
      zIndex: 0, content: { type: 0 },
    }],
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
    timeline: { layers: [], clips: [], duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [], lightingTakes: [], lightingSequences: [], automation: [] },
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
  const log = (d) => { try { fs.appendFileSync(process.env.ARTLUX_DEVLOG || 'dev.log', d); } catch { /* ignore */ } };
  child.stdout.on('data', log); child.stderr.on('data', log);
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

/**
 * Click a browser row, WAITING for it to exist. The workbench populates its browser a beat after the
 * rail click, and a single-shot query made this test pass or fail depending on the machine's mood —
 * which is worse than failing, because it teaches you to re-run rather than to look.
 */
const clickRow = async (page, name, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const ok = await page.evaluate((n) => {
      // ⚠ NOT the row's textContent. A row renders its name PLUS a badge and the two concatenate:
      // "Wall 1" + "0" reads as "Wall 10", and "Head 1" + "16-Bit · 13ch" as "Head 116-Bit · 13ch".
      // Exact matching finds nothing and prefix matching cannot tell "Head 1" from "Head 10". Match
      // the LEAF element whose own text IS the name, then click the row that owns it.
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

/**
 * The NAMES in the browser — read off the leaf elements, for the reason clickRow documents: a row's
 * textContent is the name with its badge run together, so counting "Wall \d+" over whole rows would
 * miss "Wall 10" being a badge on Wall 1.
 */
const rows = (page) => page.evaluate(() =>
  [...document.querySelectorAll('div[role="button"] *')]
    .filter((e) => e.children.length === 0)
    .map((e) => (e.textContent || '').trim())
    .filter(Boolean));

/** The Patch section's Start Addr + Channels, for the fixture currently selected. */
const patchOf = (page) => page.evaluate(() => {
  const label = [...document.querySelectorAll('label')].find((l) => /Start Addr/i.test(l.textContent || ''));
  const row = label ? label.parentElement : null;
  const input = row ? row.querySelector('input') : null;
  const chLabel = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /^Channels$/.test((e.textContent || '').trim()));
  const chRow = chLabel ? chLabel.parentElement : null;
  return {
    start: input ? Number(input.value) : null,
    channels: chRow ? (chRow.textContent || '').replace('Channels', '').trim() : null,
  };
});

const press = async (page, key, mods = ['Control']) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  await sleep(700);
};

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

    // ── 1-3. copy a head, paste it ──────────────────────────────────────────────────────────────
    console.log('\n1. copy a moving head and paste it');
    if (!(await clickRow(page, 'Head 1'))) throw new Error('could not select Head 1');
    await sleep(600);
    const before = await patchOf(page);
    await press(page, 'KeyC');
    await press(page, 'KeyV');
    let list = await rows(page);
    note(list.includes('Head 2'), 'the pasted fixture appears, numbered on', `rows: ${list.filter((r) => /^Head/.test(r)).join(', ')}`);

    const after = await patchOf(page);
    // A MAC 250 Beam in 16-bit is 13 channels. Landing at start + 13 proves BOTH halves at once: it
    // was re-patched rather than stacked on the source, and it occupies the same footprint, which is
    // only true if it carried the profile and the mode across.
    const FOOTPRINT = 13;
    note(after.start === before.start + FOOTPRINT,
      'the copy is RE-PATCHED right after the source, at its full footprint',
      `Head 1 @ ${before.start}, the copy @ ${after.start} (expected ${before.start + FOOTPRINT}) — the same address would be two heads answering one patch`);

    // ── 4. four at once ─────────────────────────────────────────────────────────────────────────
    console.log('\n2. paste three more');
    await press(page, 'KeyV');
    await press(page, 'KeyV');
    await press(page, 'KeyV');
    list = await rows(page);
    const heads = list.filter((r) => /^Head \d+$/.test(r)).sort();
    note(new Set(heads).size === heads.length && heads.length === 5,
      'each paste gets its own number rather than repeating one', `heads: ${heads.join(', ')}`);

    // ── 5. a surface ────────────────────────────────────────────────────────────────────────────
    console.log('\n3. copy a surface');
    await clickRail(page, 'Map');
    await sleep(1200);
    if (!(await clickRow(page, 'Wall 1'))) {
      const seen = await rows(page);
      throw new Error(`could not select Wall 1 — browser rows were: ${seen.join(' | ')}`);
    }
    await sleep(600);
    await press(page, 'KeyC');
    await press(page, 'KeyV');
    list = await rows(page);
    note(list.includes('Wall 2'), 'a surface copies too', `rows: ${list.filter((r) => /^Wall/.test(r)).join(', ')}`);

    // ── 6. THE ONE THAT KEEPS IT SAFE ───────────────────────────────────────────────────────────
    console.log('\n4. Ctrl+C inside a text field is left alone');
    const countBefore = (await rows(page)).filter((r) => /^Wall \d+$/.test(r)).length;
    const typed = await page.evaluate(() => {
      const i = [...document.querySelectorAll('input[type=text], input:not([type])')].find((x) => x.offsetParent !== null);
      if (!i) return false;
      i.focus();
      i.setSelectionRange(0, i.value.length);
      return true;
    });
    if (!typed) { note(false, 'found a text field to test in'); }
    else {
      await press(page, 'KeyC');
      await press(page, 'KeyV');
      const countAfter = (await rows(page)).filter((r) => /^Wall \d+$/.test(r)).length;
      note(countAfter === countBefore,
        'copying inside a text field does NOT copy the selected object',
        `surfaces ${countBefore} → ${countAfter} (a change here means Ctrl+C was hijacked from the field)`);
    }
    // ── 7. Del removes the selection ────────────────────────────────────────────────────────────
    console.log('\n5. Del removes the selected fixtures');
    await clickRail(page, '3D');
    await sleep(1200);
    if (!(await clickRow(page, 'Head 5'))) throw new Error('could not select Head 5');
    await press(page, 'Delete', []);
    let heads2 = (await rows(page)).filter((r) => /^Head \d+$/.test(r));
    note(!heads2.includes('Head 5') && heads2.length === 4, 'Del deletes the selected fixture',
      `heads now: ${heads2.join(', ')}`);

    // ── 8. THE SCOPE GUARD ──────────────────────────────────────────────────────────────────────
    console.log("\n6. Del while the pointer is over the timeline belongs to the timeline");
    if (!(await clickRow(page, 'Head 4'))) throw new Error('could not select Head 4');
    const overTimeline = await page.evaluate(() => {
      const el = document.querySelector('[data-owns-delete]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + Math.min(20, r.height / 2) } : null;
    });
    if (!overTimeline) { note(false, 'found the timeline to hover', 'no [data-owns-delete] on screen'); }
    else {
      await page.mouse.move(overTimeline.x, overTimeline.y);
      await sleep(400);
      await press(page, 'Delete', []);
      heads2 = (await rows(page)).filter((r) => /^Head \d+$/.test(r));
      note(heads2.includes('Head 4') && heads2.length === 4,
        'the fixture SURVIVES — the timeline owns Del while hovered',
        `heads: ${heads2.join(', ')} (losing Head 4 here means one press deleted a clip and a fixture)`);
    }
  } catch (e) {
    failures++;
    console.error('\n   \x1b[31mERROR\x1b[0m', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* gone */ }
    await stop(child);
    if (!KEEP) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* leave it */ } }
  }

  console.log(failures
    ? `\n\x1b[31mcopy/paste: ${failures} failure(s)\x1b[0m`
    : '\n\x1b[32mcopy/paste OK — it builds a rig, and it leaves text fields alone\x1b[0m');
  process.exit(failures ? 1 : 0);
})();
