// Runtime proof that a LIGHT SHOW can actually be authored: aim → record → place → play.
//
//   node scripts/test-lighting-take.cjs [--project=<file>] [--keep]
//
// `npm run verify` reads source, so it can assert the loop still LOOKS right. It cannot assert that
// a head follows your hand — and that is exactly what was broken: `Slider` commits on pointer
// RELEASE, nothing implemented the `live override` layer the packer names at the top of its
// precedence stack, and so a four-second pan drag reached the wire as ONE transition. The rig did
// not move while you aimed it, and because services/lightingRecorder samples the RESOLVED fixture
// signal, a busk recorded a STEP:
//
//     pan [[0.02, 136.4], [5.68, 136.4], [5.83, 403.6], [10.11, 403.6]]
//
// Everything downstream was correct and the feature was still unusable. Nothing in a typechecker,
// and nothing in a source-reading guard, can see that. This drives the real app and watches the wire.
//
// What it asserts, in the order the operator meets it:
//   1. a project of ONLY light fixtures — no surfaces, no LED fixtures — reaches the wire at all;
//   2. aiming is LIVE and drives the whole selection (many wire steps on every selected head,
//      during the drag — not one at the release, and not on the primary only);
//   3. a busk records as a MOVEMENT: every part of the take carries a multi-key curve;
//   4. the recorded take can be PLACED by dropping it on a lighting lane;
//   5. it replays on the wire, and a phase spread staggers the heads by the authored phase.
//
// It writes its own project (six moving heads in two ordered groups, zero surfaces) and points
// Art-Net at loopback on an unused port, so it never collides with the app's own input socket on
// 6454 and never touches whatever the operator last had open. Prefs are backed up and restored.

const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARTNET_PORT = 6469;           // not 6454: the app's own Art-Net INPUT socket binds that
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9371';
const KEEP = process.argv.includes('--keep');
const projectArg = process.argv.find((a) => a.startsWith('--project='));
const PREFS = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const WORK = path.join(os.tmpdir(), 'artlux-lighting-take-test');
const PREFS_BAK = path.join(WORK, 'prefs.backup.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });

let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

// ── The rig ──────────────────────────────────────────────────────────────────────────────────────
// Four MAC 250 Beams (CMY — the subtractive case) and two RGB heads, all patched into universe 0.
// NO SURFACES AND NO LED FIXTURES: that is half the point. The GPU sampling pass has nothing to
// sample here, and the frame loop must still resolve, pack and publish every profiled fixture.
const MAC = 'martin/mac-250-beam';
const RGB = 'american-dj/inno-pocket-beam-q4';
// Slot offsets within each mode, 1-based — the channels this test watches on the wire.
const MAC_PAN = 8;                  // 16bt: shutter, dimmer, C, M, Y, gobo, frost, PAN(hi), pan(lo), …
const MAC_FP = 13;
const RGB_FP = 13;

function buildProject() {
  fs.mkdirSync(WORK, { recursive: true });
  const fixtures = [];
  let addr = 1;
  const add = (id, name, profileId, profileMode, footprint, dmx, position3D) => {
    fixtures.push({
      id, name, x: 0, y: 0, width: 0.02, height: 0.02, rotation: 0,
      universe: 0, startAddress: addr, ledCount: 1, reverse: false, colorData: [],
      profileId, profileMode, dmx, position3D, controllerId: 'ctl_dmx',
    });
    addr += footprint;
  };
  // Shutter OPEN is a BAND, not a value — 20..49 on the MAC, 8..15 on the ADJ. Park in the middle.
  const mac = () => ({ 'shutter-strobe': 35 / 255, dimmer: 1, pan: 0.5, tilt: 0.5, 'cyan-intensity': 0, 'magenta-intensity': 0, 'yellow-intensity': 0 });
  const rgb = (r, g, b) => ({ 'shutter-strobe': 12 / 255, dimmer: 1, pan: 0.5, tilt: 0.5, red: r, green: g, blue: b, white: 0 });

  for (let i = 0; i < 4; i++) add(`fx_mover_${i + 1}`, `Mover ${i + 1}`, MAC, '16bt', MAC_FP, mac(), { x: -3 + i * 2, y: 5, z: -4 });
  add('fx_wash_1', 'Wash 1', RGB, '13ch', RGB_FP, rgb(1, 0, 0), { x: -2, y: 4, z: 2 });
  add('fx_wash_2', 'Wash 2', RGB, '13ch', RGB_FP, rgb(0, 0.4, 1), { x: 2, y: 4, z: 2 });

  const file = path.join(WORK, 'lighting-take-test.artlux');
  fs.writeFileSync(file, JSON.stringify({
    version: '1.2',
    timestamp: '2026-01-01T00:00:00.000Z',
    surfaces: [],
    fixtures,
    controllers: [{ id: 'ctl_dmx', name: 'Lighting interface', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, startUniverse: 0, drives: 'light' }],
    globalBrightness: 1,
    groups: [
      { id: 'grp_movers', name: 'Movers', fixtureIds: ['fx_mover_1', 'fx_mover_2', 'fx_mover_3', 'fx_mover_4'] },
      { id: 'grp_washes', name: 'Washes', fixtureIds: ['fx_wash_1', 'fx_wash_2'] },
    ],
    scenes: [], cueBanks: [],
    scene3D: { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, reflectiveFloor: false, trackingViz: false, augmentaViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50 },
    timeline: {
      layers: [{ id: 'lay_lighting', name: 'Lighting', kind: 'lighting', color: '#f5a623', enabled: true }],
      clips: [], duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false,
      trackingTakes: [], lightingTakes: [], lightingSequences: [],
    },
    schedule: [], assets: [], projectorOutputs: [], projectorFpsCap: 0, projectorBrightness: 1,
  }, null, 2));
  return file;
}

// ── The wire ─────────────────────────────────────────────────────────────────────────────────────
// A history of the watched channels, not just a count: the whole question here is WHEN a value
// changed, so a packet counter would answer the wrong thing.
function sniffer(watch) {
  const s = { packets: 0, universes: {}, hist: [], t0: Date.now() };
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf) => {
    if (buf.length < 18 || buf.toString('latin1', 0, 8) !== 'Art-Net\u0000' || buf.readUInt16LE(8) !== 0x5000) return;
    const uni = buf.readUInt16LE(14);
    const d = buf.subarray(18, 18 + buf.readUInt16BE(16));
    s.packets++;
    s.universes[uni] = Array.from(d.subarray(0, 128));
    if (uni === 0) {
      s.hist.push([Date.now() - s.t0, ...watch.map((c) => d[c - 1])]);
      if (s.hist.length > 6000) s.hist.shift();
    }
  });
  return { s, sock };
}

function launch(project) {
  const env = { ...process.env };
  // Inheriting this makes Electron boot as plain Node — a documented gotcha; see docs/DEVELOPMENT.md.
  delete env.ELECTRON_RUN_AS_NODE;
  env.ARTLUX_CDP_PORT = CDP_PORT;
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '--', '--', `--project=${project}`], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

async function stop(child) {
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  try { execSync(process.platform === 'win32' ? 'taskkill /IM electron.exe /F /T' : 'pkill -f electron', { stdio: 'ignore' }); } catch { /* none running */ }
  await sleep(2500);
}

// ── Driving the shell ────────────────────────────────────────────────────────────────────────────
// Selectors that bit, kept here so the next person does not rediscover them: the rail is labelled by
// `shortTitle` ("3D", not "Venue & Rig"); a dock TAB is `[role=tab]`, not a <button>; a lane's name
// is an <input> in its TrackHeader, so the lane row is that input's `.relative` ancestor.

const clickRail = (page, short) => page.evaluate((s) => {
  const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === s);
  if (b) b.click();
  return !!b;
}, short);

const openDockTab = (page, title) => page.evaluate((t) => {
  const tab = [...document.querySelectorAll('[role=tab]')].find((e) => (e.textContent || '').trim() === t);
  if (tab) tab.click();
  return !!tab;
}, title);

/** Click the browser rows for these fixtures IN ORDER — ctrl for every one after the first. */
const selectFixtures = async (page, names) => {
  for (let i = 0; i < names.length; i++) {
    const ok = await page.evaluate((n, ctrl) => {
      const row = [...document.querySelectorAll('div[role="button"]')].find((d) => (d.textContent || '').trim() === n);
      if (!row) return false;
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: ctrl, view: window }));
      return true;
    }, names[i], i > 0);
    if (!ok) return names[i];
    await sleep(200);
  }
  return null;
};

/** A REAL mouse drag across a labelled fader — the gesture the whole feature depends on. */
async function dragSlider(page, label, from, to, ms) {
  const b = await page.evaluate((l) => {
    const el = [...document.querySelectorAll('input[type=range]')].find((i) => {
      const lab = document.querySelector(`label[for="${CSS.escape(i.id)}"]`);
      return lab && lab.textContent.trim() === l;
    });
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, label);
  if (!b) throw new Error(`no "${label}" fader in the channel strip`);
  const y = b.y + b.h / 2;
  const xAt = (f) => b.x + 8 + (b.w - 16) * f;
  const steps = Math.max(2, Math.round(ms / 25));
  await page.mouse.move(xAt(from), y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(xAt(from + (to - from) * (i / steps)), y); await sleep(25); }
  await page.mouse.up();
}

const clickButton = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim().startsWith(t));
  if (b) { b.click(); return (b.textContent || '').trim(); }
  return null;
}, text);

/** Save in place, so the assertions can read the document rather than guess at it from the DOM. */
const saveProject = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Save Project');
  if (b) { b.click(); return true; }
  return false;
});

(async () => {
  if (!puppeteer) {
    console.error('puppeteer-core is required (it ships with the repo devDependencies).');
    process.exit(1);
  }
  fs.mkdirSync(WORK, { recursive: true });
  const project = projectArg ? projectArg.slice('--project='.length) : buildProject();
  const hadPrefs = fs.existsSync(PREFS);
  if (hadPrefs) fs.copyFileSync(PREFS, PREFS_BAK);

  const failures = [];
  const note = (ok, label, detail) => {
    console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures.push(label);
  };
  const read = () => JSON.parse(fs.readFileSync(project, 'utf8'));

  // The four movers' PAN high bytes, in patch order.
  const watch = [0, 1, 2, 3].map((i) => i * MAC_FP + MAC_PAN);
  let child = null, browser = null, sock = null;
  try {
    const prefs = hadPrefs ? JSON.parse(fs.readFileSync(PREFS, 'utf8')) : {};
    prefs.appSettings = { ...(prefs.appSettings || {}), outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: ARTNET_PORT, broadcast: false, protocol: 'artnet' };
    fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2));

    console.log('project :', project);
    console.log('art-net :', `127.0.0.1:${ARTNET_PORT}`);
    console.log('watching:', watch.map((c, i) => `Mover ${i + 1} pan = ch${c}`).join(', '));

    const wire = sniffer(watch);
    sock = wire.sock;
    await new Promise((r) => sock.bind(ARTNET_PORT, '0.0.0.0', r));
    child = launch(project);

    let ver = null;
    for (let i = 0; i < 180 && !ver; i++) { try { ver = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { await sleep(1000); } }
    if (!ver) throw new Error('the app never came up on CDP');
    browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
    let page = null;
    for (let i = 0; i < 40 && !page; i++) {
      for (const p of await browser.pages()) { const u = p.url(); if (/localhost:3000|index\.html/.test(u) && !/projector|splash|docs/.test(u)) { page = p; break; } }
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('no renderer target found');
    await sleep(26000); // boot + project load + the cold-start decode gate

    // ── 1. a rig of nothing but lights still reaches the wire ───────────────────────────────────
    console.log('\n1. a project with NO surfaces and NO LED fixtures still outputs');
    wire.s.packets = 0;
    await sleep(4000);
    const u0 = wire.s.universes[0] || [];
    // Mover 1 parks at pan 0.5 of a 0..540 head, so its high byte is 128 and the head is at ~271°.
    note(wire.s.packets > 0 && u0[MAC_PAN - 1] === 128, 'ArtDmx carries the parked rig',
      `${wire.s.packets} packets · Mover 1 ch1-13 = ${u0.slice(0, MAC_FP).join(',')}`);

    // ── 2. aiming is live, and drives the whole selection ───────────────────────────────────────
    console.log('\n2. aiming a head is LIVE, and one fader moves every selected light');
    await clickRail(page, '3D');
    await sleep(1500);
    await openDockTab(page, 'Lighting Takes');
    await sleep(600);
    const missing = await selectFixtures(page, ['Mover 1', 'Mover 2', 'Mover 3', 'Mover 4']);
    if (missing) throw new Error(`no browser row for "${missing}" — the 3D fixture list has moved`);
    const mark = wire.s.hist.length;
    await dragSlider(page, 'Pan', 0.25, 0.8, 4000);
    await sleep(800);
    const during = wire.s.hist.slice(mark);
    const steps = watch.map((_, i) => new Set(during.map((r) => r[i + 1])).size);
    // A commit-on-release fader shows ONE value here (or two, counting the jump). A live one shows
    // dozens, on every selected head — which is the whole difference between aiming and guessing.
    note(steps.every((n) => n > 20), 'the rig follows the hand, on all four heads',
      `distinct DMX values during the drag: ${steps.join(', ')}`);

    // ── 3. a busk records a movement, not a step ────────────────────────────────────────────────
    console.log('\n3. a busk records as a MOVEMENT, and every part of the take carries it');
    const armed = await clickButton(page, 'Record move');
    if (!armed) throw new Error('no "Record move" button — the Lighting Takes dock did not open');
    await sleep(600);
    await dragSlider(page, 'Pan', 0.8, 0.25, 3500);
    await sleep(300);
    await dragSlider(page, 'Tilt', 0.5, 0.2, 2000);
    await sleep(500);
    await clickButton(page, 'Stop');
    await sleep(1500);
    await saveProject(page);
    await sleep(1500);
    const take = (read().timeline.lightingTakes || [])[0];
    if (!take) throw new Error('nothing was recorded — the take never reached the document');
    const perPart = take.parts.map((p) => Object.entries(p.channels).map(([r, k]) => `${r}:${k.length}`).join(' ') || 'EMPTY');
    // A STEP AND A MOVEMENT BOTH FIT IN FOUR KEYFRAMES, so counting keys proves nothing — the broken
    // take was [[0.02,136.4],[5.68,136.4],[5.83,403.6],[10.11,403.6]]: four keys, and all of the travel
    // inside one 0.15 s segment. What tells them apart is how much of the take the value spends
    // CHANGING — a couple of percent for a jump, tens of percent for a hand on a fader.
    const movingFraction = (kfs) => {
      if (!kfs || kfs.length < 2) return 0;
      let moving = 0;
      for (let i = 1; i < kfs.length; i++) if (Math.abs(kfs[i].v - kfs[i - 1].v) > 2) moving += kfs[i].t - kfs[i - 1].t;
      return moving / Math.max(1e-6, take.duration);
    };
    const frac = take.parts.map((p) => movingFraction(p.channels.pan));
    note(take.parts.length === 4 && frac.every((f) => f > 0.15), 'every part carries a pan MOVEMENT, not a jump',
      `${take.duration.toFixed(1)}s · ${take.parts.length} parts · ${perPart.join(' | ')}`
      + ` · pan moving for ${frac.map((f) => Math.round(f * 100) + '%').join('/')} of the take`);

    // ── 4. the take can be placed by dropping it where it plays ─────────────────────────────────
    console.log('\n4. the take drops onto the lighting lane');
    const dropped = await page.evaluate(() => {
      const chip = [...document.querySelectorAll('div[draggable=true]')].find((d) => /·\s*\d+p\s*·/.test(d.innerText || ''));
      if (!chip) return { err: 'no take chip in the library' };
      // Ask the chip what it puts on the clipboard, exactly as a real drag would.
      const probe = new DataTransfer();
      chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: probe }));
      const id = probe.getData('application/artlux-take');
      if (!id) return { err: 'the chip sets no application/artlux-take payload' };
      const laneInput = [...document.querySelectorAll('input')].find((i) => i.type !== 'range' && i.value === 'Lighting');
      if (!laneInput) return { err: 'no Lighting lane header — is the timeline drawer open?' };
      const r = laneInput.closest('div.relative').getBoundingClientRect();
      const y = r.y + r.height / 2, x = 620;
      const dt = new DataTransfer();
      dt.setData('application/artlux-take', id);
      document.elementFromPoint(x, y).dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
      return { id };
    });
    if (dropped.err) throw new Error(dropped.err);
    await sleep(1000);
    await saveProject(page);
    await sleep(1500);
    const clip = read().timeline.clips.find((c) => c.kind === 'lighting' && c.lighting && c.lighting.takeId === dropped.id);
    note(!!clip, 'a lighting clip playing the take appeared on the lane',
      clip ? `start ${clip.start.toFixed(1)}s · ${clip.duration.toFixed(1)}s · group ${clip.lighting.groupId || '(none)'}` : 'nothing was created');
    if (!clip) throw new Error('no clip to play');

    // ── 5. it replays, and a phase spread staggers the rig by exactly what was authored ─────────
    console.log('\n5. it replays on the wire, and a phase spread makes it a chase');
    const PHASE = 0.6;
    const patched = await page.evaluate((clipId, phase, groupId) => {
      // Author the clip through its own inspector: select it, then set Group and Phase.
      const lane = [...document.querySelectorAll('input')].find((i) => i.type !== 'range' && i.value === 'Lighting');
      const r = lane.closest('div.relative').getBoundingClientRect();
      const y = r.y + r.height / 2;
      const block = [...document.querySelectorAll('div[class*="absolute top-1 bottom-1"]')]
        .find((d) => { const b = d.getBoundingClientRect(); return Math.abs(b.y + b.height / 2 - y) < 30; });
      if (!block) return 'no clip block on the lighting lane';
      const b = block.getBoundingClientRect();
      const x = b.x + Math.min(30, b.width / 2);
      for (const t of ['pointerdown', 'pointerup']) block.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, isPrimary: true }));
      block.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      return null;
    }, clip.id, PHASE, 'grp_movers');
    if (patched) throw new Error(patched);
    await sleep(800);
    const authored = await page.evaluate((phase) => {
      const labelled = (t) => [...document.querySelectorAll('span')].find((s) => (s.textContent || '').trim() === t);
      const g = labelled('Group'); const p = labelled('Phase s');
      if (!g || !p) return 'the lighting clip inspector did not open';
      const sel = g.parentElement.querySelector('select');
      const opt = [...sel.options].find((o) => /Movers/.test(o.text));
      if (!opt) return 'no Movers group in the clip inspector';
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const inp = p.parentElement.querySelector('input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(inp, String(phase));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return null;
    }, PHASE);
    if (authored) throw new Error(authored);
    await sleep(800);

    const playMark = wire.s.hist.length;
    await page.evaluate(() => {
      const stopBtn = [...document.querySelectorAll('button')].find((b) => /^Stop — pause/.test(b.getAttribute('title') || ''));
      const play = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Play / Pause (Space)');
      if (stopBtn) stopBtn.click();
      setTimeout(() => play && play.click(), 400);
    });
    await sleep(Math.round((clip.start + clip.duration + 3) * 1000));
    await page.evaluate(() => {
      const play = [...document.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Play / Pause (Space)');
      if (play) play.click();
    });

    const replay = wire.s.hist.slice(playMark);
    const moved = watch.map((_, i) => new Set(replay.map((r) => r[i + 1])).size);
    note(moved.every((n) => n > 20), 'the recorded movement plays back on all four heads',
      `distinct DMX values during playback: ${moved.join(', ')}`);

    // The stagger: when each head first crosses the middle of its travel, relative to head 1.
    const cross = watch.map((_, i) => {
      for (let k = 1; k < replay.length; k++) {
        if (replay[k][i + 1] >= 150 && replay[k - 1][i + 1] < 150) return replay[k][0] / 1000;
      }
      return null;
    });
    const gaps = cross.slice(1).map((t, i) => (t !== null && cross[i] !== null ? t - cross[i] : null));
    const ok = gaps.length === 3 && gaps.every((g) => g !== null && Math.abs(g - PHASE) < 0.25);
    note(ok, `the spread staggers the heads by the authored ${PHASE}s`,
      gaps.every((g) => g !== null) ? `gaps: ${gaps.map((g) => g.toFixed(2) + 's').join(', ')}` : 'a head never crossed mid-travel');
  } catch (e) {
    failures.push('harness: ' + e.message);
    console.error('\nharness error:', e.message);
  } finally {
    try { if (browser) await browser.disconnect(); } catch { /* ignore */ }
    if (child) await stop(child);
    try { if (sock) sock.close(); } catch { /* ignore */ }
    if (hadPrefs && fs.existsSync(PREFS_BAK)) { fs.copyFileSync(PREFS_BAK, PREFS); console.log('\nprefs restored'); }
    if (!KEEP && !projectArg) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ } }
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed:\n   ` + failures.join('\n   '));
    process.exit(1);
  }
  console.log('\nlighting take OK — a light show can be aimed, recorded, placed and played');
  process.exit(0);
})();
