// ArtLux documentation screenshot harness.
//
// Launches the dev build with the Chromium remote-debugging (CDP) endpoint enabled
// (via ARTLUX_CDP_PORT, honoured by src/main/index.ts), seeds a deterministic demo
// project (built into the OS temp dir — nothing binary is committed), drives the UI to
// each context, and writes PNGs into docs/user-guide/images/.
//
// The user's own last-opened project is backed up and restored, so running this never
// changes which project the app reopens normally.
//
// Usage:  node scripts/capture-docs.cjs            (full run)
//         node scripts/capture-docs.cjs --spike    (just prove launch + connect + 1 shot)
//
// No Chromium download: puppeteer-core attaches to the already-running Electron renderer.

const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');
const { shellSignature } = require('./lib/shell-signature.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'user-guide', 'images');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9333';
const DEV_URL = 'http://localhost:3000/';
const DEV_URL_HINT = 'localhost:3000';
const SPIKE = process.argv.includes('--spike');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Demo project — self-contained, deterministic, built into the OS temp dir.
// ---------------------------------------------------------------------------
function buildDemoProject() {
    const dir = path.join(os.tmpdir(), 'artlux-doc-demo');
    const imgDir = path.join(dir, 'assets', 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    const logo = path.join(imgDir, 'logo.png');
    fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), logo);

    // AUDIO for the Audio Bed shot (user-guide §7). Copied out of the committed audio example set — the
    // same door `logo` uses, and for the same reason: the demo project lives in the OS temp dir, so its
    // asset paths must be ABSOLUTE. Without this the mixer captures EMPTY, which would document nothing.
    const audDir = path.join(dir, 'assets', 'audio');
    fs.mkdirSync(audDir, { recursive: true });
    const bedWav = path.join(audDir, 'bed-count.wav');
    const stingWav = path.join(audDir, 'sting-main.wav');
    fs.copyFileSync(path.join(ROOT, 'examples/audio/assets/audio/bed-count.wav'), bedWav);
    fs.copyFileSync(path.join(ROOT, 'examples/audio/assets/audio/sting-main.wav'), stingWav);

    const sId = 'srf-logo', fxId = 'srf-fx';
    const stripId = 'fix-strip', matrixId = 'fix-matrix';
    const ctrlId = 'ctrl-main';
    const layA = 'lay-a', layB = 'lay-b';

    const project = {
        version: '1.2',
        timestamp: '2026-06-30T00:00:00.000Z',
        surfaces: [
            { id: sId, name: 'Logo Wall', x: 0.05, y: 0.10, width: 0.42, height: 0.52, rotation: 0, zIndex: 0,
              content: { type: 'IMAGE', url: logo } },
            { id: fxId, name: 'FX Panel', x: 0.53, y: 0.10, width: 0.42, height: 0.52, rotation: 0, zIndex: 1,
              content: { type: 'EFFECT', effectId: 1, paletteId: 0, speed: 0.5, intensity: 0.8 } },
        ],
        fixtures: [
            { id: matrixId, name: 'Matrix 16x16', x: 0.10, y: 0.16, width: 0.30, height: 0.36, rotation: 0,
              universe: 0, startAddress: 1, ledCount: 256, reverse: false, colorData: [], surfaceId: sId,
              shape: 'MATRIX', matrixWidth: 16, matrixHeight: 16, serpentine: true,
              colorOrder: 'GRB', channelsPerPixel: 3, controllerId: ctrlId,
              source: 'MEDIA', position3D: { x: -0.5, y: 1.2, z: 0 }, rotation3D: { pitch: 0, yaw: 0, roll: 0 },
              layout3D: { type: 'matrix', ledSpacing: 0.02, matrixRows: 16, matrixCols: 16, serpentine: true, arcRadius: 1, arcAngle: 180 }, scale3D: 1 },
            { id: stripId, name: 'LED Strip', x: 0.55, y: 0.50, width: 0.38, height: 0.03, rotation: 0,
              universe: 2, startAddress: 1, ledCount: 60, reverse: false, colorData: [], surfaceId: fxId,
              shape: 'LINE', colorOrder: 'GRB', channelsPerPixel: 3, controllerId: ctrlId,
              source: 'MEDIA', position3D: { x: 0.6, y: 0.9, z: 0 }, rotation3D: { pitch: 0, yaw: 0, roll: 0 },
              layout3D: { type: 'line', ledSpacing: 0.0166, matrixRows: 8, matrixCols: 8, serpentine: true, arcRadius: 1, arcAngle: 180 }, scale3D: 1 },
        ],
        controllers: [
            { id: ctrlId, name: 'Main DMX', protocol: 'artnet', ip: '192.168.1.50', broadcast: false, priority: 100, startUniverse: 0 },
        ],
        settings: {
            artNetIp: '192.168.1.255', artNetPort: 6454, outputEnabled: true, broadcast: true,
            gamma: 1.2, protocol: 'artnet', fps: 44, keepAlive: true, artNetSync: true,
            oscEnabled: false, oscListenPort: 10000, oscListenAddress: '', oscControlPrefix: '/artlux', helpLang: 'en',
        },
        globalBrightness: 1,
        groups: [ { id: 'grp-all', name: 'All Fixtures', fixtureIds: [matrixId, stripId] } ],
        // ⚠ EVERY SCENE OWNS A TIMELINE. `Scene.timeline` became REQUIRED on 2026-07-14 — the timeline-less
        // scene ("plays the global one") was the root of two automation-clock blockers and the shape was
        // DELETED. This demo carried the old shape; the loader would have silently defaulted it, but seeding
        // a deleted shape from our own screenshot harness is how a dead shape stays alive.
        // The scene also owns a STING on its own audio — which is the whole point of §7: a scene's audio
        // restarts on every recall, while the bed does not.
        scenes: [ { id: 'scn-a', name: 'Look A', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, groups: [],
            timeline: {
                layers: [], clips: [], duration: 20, fps: 30, markers: [],
                inPoint: null, outPoint: null, loop: false, trackingTakes: [],
                audio: {
                    tracks: [ { id: 'atr-sting', name: 'Sting', gain: 1, mute: false } ],
                    clips: [ { id: 'acl-sting', trackId: 'atr-sting', name: 'sting-main', path: stingWav,
                               start: 0, duration: 1.6, inPoint: 0, sourceDuration: 1.6, gain: 0.5, mute: false } ],
                },
            } } ],
        cueBanks: [ { id: 'bank-1', name: 'Bank 1', rows: 8, cols: 16, cues: [], sceneCells: [ { col: 0, sceneId: 'scn-a' } ] } ],
        scene3D: {
            models: [ { id: 'mdl-screen', name: 'Screen 1', kind: 'plane', path: '', position: { x: 0, y: 1.2, z: -1.0 },
                        rotation: { x: 0, y: 0, z: 0 }, scale: 2, visible: true, layerId: '__program__', scaleXYZ: [2, 2, 2] } ],
            lightIntensity: 0.7, environment: false, exposure: 0.8, gridVisible: true, reflectiveFloor: true,
            trackingViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50, trackingLabels: true,
            trackingMergePeople: false, trackingMergeRadius: 0.8,
        },
        timeline: {
            layers: [
                { enabled: true, id: layA, name: 'Layer 1', color: '#7ed321', height: 80 },
                { enabled: true, id: layB, name: 'Layer 2', color: '#4a90e2', height: 80 },
            ],
            clips: [
                { id: 'clip-1', layerId: layA, name: 'Logo', content: { type: 'IMAGE', url: logo }, path: '', start: 0, duration: 6, inPoint: 0 },
                { id: 'clip-2', layerId: layA, name: 'Rainbow FX', content: { type: 'EFFECT', effectId: 1, paletteId: 0, speed: 0.5, intensity: 0.8 }, path: '', start: 6.5, duration: 8, inPoint: 0 },
                { id: 'clip-3', layerId: layB, name: 'Wash', content: { type: 'EFFECT', effectId: 2, paletteId: 2, speed: 0.3, intensity: 0.6 }, path: '', start: 2, duration: 10, inPoint: 0 },
            ],
            duration: 30, fps: 30, markers: [ { id: 'mk-1', time: 4, label: 'Cue 1' } ],
            inPoint: 0, outPoint: 16, loop: true,
            stateMachine: { enabled: false, states: [], transitions: [], initialStateId: null },
            trackingTakes: [],
            // An automation lane on the house level, so the timeline shot shows a real curve and the Audio
            // Bed's master fader shows its `LANE` badge — which is precisely what §7 is about.
            automation: [
                { id: 'lane-master', targetPath: 'audio.master.gain', enabled: true, height: 64, color: '#f59e0b',
                  keyframes: [ { t: 0, v: 1, curve: 'linear' }, { t: 8, v: 1, curve: 'linear' },
                               { t: 12, v: 0.35, curve: 'linear' }, { t: 22, v: 0.35, curve: 'linear' },
                               { t: 27, v: 1, curve: 'linear' } ] },
            ],
        },
        // THE BED (ProjectData.audio) — one per project, rides the SHOW clock, survives a scene recall.
        // Two tracks, because the mixer's whole shape only reads once there is more than one.
        audio: {
            tracks: [
                { id: 'atr-bed', name: 'Bed', gain: 1, mute: false },
                { id: 'atr-room', name: 'Room', gain: 0.7, mute: false },
            ],
            clips: [
                { id: 'acl-bed', trackId: 'atr-bed', name: 'bed-count', path: bedWav,
                  start: 0, duration: 30, inPoint: 0, sourceDuration: 36, gain: 1, mute: false },
            ],
            buses: [
                { id: 'master', name: 'Master', gain: 1,
                  effects: [ { id: 'fx-comp', type: 'compressor',
                               params: { thresholdDb: -12, ratio: 3, attackMs: 8, releaseMs: 140, makeupDb: 1.5 } } ] },
            ],
        },
        assets: [
            { id: 'ast-logo', name: 'logo.png', type: 'image', path: logo, width: 512, height: 512, addedAt: '2026-06-30T00:00:00.000Z' },
            { id: 'ast-bed', name: 'bed-count.wav', type: 'audio', path: bedWav, addedAt: '2026-06-30T00:00:00.000Z' },
            { id: 'ast-sting', name: 'sting-main.wav', type: 'audio', path: stingWav, addedAt: '2026-06-30T00:00:00.000Z' },
        ],
        projectorOutputs: [
            { surfaceId: sId, enabled: false, displayId: null,
              cornerPin: { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] }, warp: null,
              softEdge: { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 }, ndiSend: false },
        ],
        projectorFpsCap: 30, projectorBrightness: 1,
    };

    const file = path.join(dir, 'project.artlux');
    fs.writeFileSync(file, JSON.stringify(project, null, 2), 'utf-8');
    return file;
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------
function getJson(url, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}

async function waitForCdp(deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try {
            const ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
            if (ver && ver.webSocketDebuggerUrl) return ver;
        } catch { /* not up yet */ }
        await sleep(800);
    }
    throw new Error(`CDP endpoint not reachable on :${CDP_PORT} within ${deadlineMs}ms`);
}

async function findRendererTarget(browser, deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        for (const p of await browser.pages()) {
            const u = p.url();
            if (u.includes(DEV_URL_HINT) || (u.startsWith('http') && !u.includes('devtools'))) return p;
        }
        await sleep(500);
    }
    throw new Error('No renderer page target found over CDP');
}

function killTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
        else process.kill(-pid, 'SIGKILL');
    } catch { /* gone */ }
}

// ---------------------------------------------------------------------------
// In-page interaction helpers — real mouse clicks via bounding box, the most
// faithful way to drive menus + tabs (synthetic DOM .click() is flaky for them).
// ---------------------------------------------------------------------------

// Find the bounding box of the best matching element. Match by title/aria-label
// or by text (exact preferred, then contains). `region` filters by screen area:
// {maxLeft,maxTop} keeps only elements whose rect starts within those bounds.
async function findBox(page, { title, text, exact, region }) {
    return page.evaluate((opts) => {
        const visible = (e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (e.offsetParent !== null || e.getClientRects().length > 0);
        };
        const inRegion = (e) => {
            if (!opts.region) return true;
            const r = e.getBoundingClientRect();
            return (opts.region.maxLeft == null || r.left <= opts.region.maxLeft) &&
                   (opts.region.maxTop == null || r.top <= opts.region.maxTop);
        };
        let el = null;
        if (opts.title) {
            el = [...document.querySelectorAll(`[title="${opts.title}"], [aria-label="${opts.title}"]`)]
                .find((e) => visible(e) && inRegion(e));
        } else if (opts.text) {
            const cands = [...document.querySelectorAll('button, [role="tab"], a, li, div, span')]
                .filter((e) => visible(e) && inRegion(e) && e.textContent);
            let matches = cands.filter((e) => e.textContent.trim() === opts.text);
            if (!matches.length && !opts.exact) matches = cands.filter((e) => e.textContent.includes(opts.text));
            // most specific = shortest text content (a leaf span, not a container)
            matches.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
            el = matches[0] || null;
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { title, text, exact, region });
}

async function click(page, matcher, opts = {}) {
    const box = await findBox(page, matcher);
    if (!box) {
        if (opts.optional) return false;
        throw new Error(`click: no match for ${JSON.stringify(matcher)}`);
    }
    await page.mouse.click(box.x, box.y);
    await sleep(opts.wait || 450);
    return true;
}

const clickTitle = (page, title, opts) => click(page, { title }, opts);
const clickText = (page, text, opts = {}) => click(page, { text, exact: opts.exact }, opts);

// Open a top-level menu (File/Edit/View/Window/Help) then click one of its items.
async function menuAction(page, menu, item) {
    await click(page, { text: menu, exact: true, region: { maxTop: 36 } });
    await sleep(300);
    await click(page, { text: item }); // dropdown item (matches with ellipsis via contains)
}

// ── WORKBENCH NAVIGATION (2026-07-29) ─────────────────────────────────────────────────────────────────
// This script was written for the OLD fixed shell — a Scene/Media tab column, a Stage/3D split, a
// four-tab dock — and it drove that shell by clicking text inside hard-coded screen regions
// (`maxLeft: 300` was "the left panel"). The app is now NINE workbenches on a left rail, each composing
// panels that the operator can drag into tabs and splits, so those regions mean nothing and the first
// wait (`/Logo Wall|FX Panel/`) hung forever: the app restores the LAST USED context, which is very
// often not the one showing surfaces.
//
// So navigation is explicit now. The rail button carries `title="<Context title> — <cluster>  (Ctrl+N)"`
// (ContextRail.tsx), which is a stable, human-meaningful hook — better than the Ctrl+1..9 accelerators,
// whose numbering follows the rail's CLUSTER ordering rather than registration order.
const CONTEXTS = {
  mapping: 'Mapping',
  scene3d: 'Venue & Rig',
  outputs: 'Projection Outputs',
  calib: 'Calibration',
  scenes: 'Scenes & Cues',
  prefs: 'Preferences',
  machine: 'Show Machine',
  audio: 'Audio',
  show: 'Show / Perform',
};

// After ANY reload, RE-ACQUIRE the renderer target and land somewhere known before waiting on project
// content. Returns the fresh Page — always assign it back (`page = await settleAfterReload(browser)`).
//
// Three traps live here and each cost a run to find:
//
// 1. The app restores the LAST context it was in. A reload following the calibration shot comes back on
//    the Calibration workbench, where no surface name is on screen — so a naive wait for "Logo Wall"
//    hangs for its full timeout. Choose the workbench first, then wait for content.
//
// 2. The app NAVIGATES ITSELF during startup (the same trap engine-decoupling.md records for
//    `?uiperf=1` not surviving startup). A poll running across that dies with "Execution context was
//    destroyed", which reads like a broken selector and is not.
//
// 3. Worse, the renderer TARGET is replaced, not just its context — so the Page handle captured before
//    the reload goes stale and every call on it throws "Attempted to use detached Frame". Re-acquiring
//    the target inside the retry is the only thing that survives this; waiting harder does not.
async function settleAfterReload(browser) {
  const RAIL = 'nav[aria-label="Workspace context"] button[title]';
  let last = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const p = await findRendererTarget(browser, 20000);
      await p.waitForFunction((sel) => !!document.querySelector(sel), { timeout: 12000 }, RAIL);
      await goContext(p, 'mapping');
      await p.waitForFunction(() => /Logo Wall|FX Panel/i.test(document.body.innerText), { timeout: 12000 });
      return p;
    } catch (e) {
      last = e;
      await sleep(1500);
    }
  }
  throw new Error(`settleAfterReload failed after 8 attempts: ${last && last.message}`);
}

async function redactPrivate(page) {
  await page.evaluate(() => {
    const EXAMPLE_HOST = 'http://192.168.0.10:8788';

    // The LAN URL the tablet is told to open.
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    while (walk.nextNode()) hits.push(walk.currentNode);
    for (const n of hits) {
      const t = n.nodeValue || '';
      const re = /https?:\/\/\d{1,3}(\.\d{1,3}){3}:\d+/g;
      if (re.test(t)) n.nodeValue = t.replace(/https?:\/\/\d{1,3}(\.\d{1,3}){3}:\d+/g, EXAMPLE_HOST);
    }

    // The pairing PIN, targeted STRUCTURALLY: the element whose previous sibling is exactly the label
    // "PIN" (ShowControlSettings.tsx renders <span>PIN</span><span class="num ...">{pin}</span>).
    //
    // Two looser rules were tried and both were wrong the same way. "Any lone 4-digit run", and then
    // "any lone 4-digit run with a PIN label within three ancestors", BOTH rewrote the port field's
    // caption to "default 0000" when the real default is 8788 - the second because three levels up
    // reaches the whole Show Control card, which of course contains the word PIN. A redaction that
    // invents a wrong fact is worse than the exposure it prevents, and the only thing that caught it
    // was reading the picture instead of trusting the tick beside it.
    for (const el of document.querySelectorAll('span, div')) {
      const prev = el.previousElementSibling;
      if (prev && (prev.textContent || '').trim() === 'PIN' && /\d/.test(el.textContent || '')) {
        el.textContent = (el.textContent || '').replace(/\d/g, '0');
      }
    }
  });
}

async function goContext(page, key) {
  const title = CONTEXTS[key];
  if (!title) throw new Error(`goContext: unknown context "${key}"`);
  const ok = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button[title]')]
      .find((b) => (b.getAttribute('title') || '').startsWith(t + ' —'));
    if (!btn) return false;
    btn.click();
    return true;
  }, title);
  if (!ok) throw new Error(`goContext: no rail button for "${title}" — the workbench set changed`);
  await sleep(700);   // context switch + the dock tree's layout effects
}

async function shoot(page, name) {
    const file = path.join(OUT_DIR, name);
    await page.screenshot({ path: file });
    console.log(`[capture]   ✓ ${name}`);
}

async function safeShoot(page, name, setup) {
    try {
        if (setup) await setup();
        await sleep(500);
        await shoot(page, name);
        return true;
    } catch (e) {
        console.warn(`[capture]   ✗ ${name} — ${e.message}`);
        return false;
    }
}

async function escClose(page) {
    await page.keyboard.press('Escape');
    await sleep(350);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const demo = buildDemoProject();
    console.log(`[capture] demo project: ${demo}`);

    const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT };
    delete env.ELECTRON_RUN_AS_NODE;

    const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite');
    console.log(`[capture] launching dev (CDP :${CDP_PORT}) …`);
    // ⚠ --calibrate, ALWAYS. The guide has a calibration chapter, and a plain editor launch does not
    // carry that workbench at all (src/main/runProfile.ts): the Calib rail entry is absent, so
    // `13-calibration.png` silently captured whatever context happened to be open — it shot the
    // Mapping workbench once, and nothing failed, because a screenshot of the wrong screen is still
    // a screenshot. The docs shoot the SUPERSET of what the app can show, so every chapter has a
    // subject; chapters that document the plain editor are unaffected by the extra rail entry.
    const child = spawn(bin, ['dev', '--', '--calibrate'], {
        cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32', detached: process.platform !== 'win32',
    });
    child.stdout.on('data', (d) => process.stdout.write(`[dev] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[dev:err] ${d}`));

    let browser, origLastProject;
    try {
        const ver = await waitForCdp(120000);
        console.log(`[capture] CDP up: ${ver.Browser || 'electron'}`);
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
        let page = await findRendererTarget(browser, 30000);
        await page.waitForFunction(() => document.body && /Surfaces|Fixtures/i.test(document.body.innerText), { timeout: 60000 });

        // Back up the user's last project, point the app at the demo, reload.
        origLastProject = await page.evaluate(async () => (await window.artlux.getPrefs())?.lastProjectPath ?? null);
        console.log(`[capture] backing up lastProjectPath: ${origLastProject}`);
        await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), demo);
        await page.reload({ waitUntil: 'domcontentloaded' });
        page = await settleAfterReload(browser);
        await sleep(2500); // let media decode + first paint settle
        console.log('[capture] demo loaded, capturing contexts …');

        if (SPIKE) { await shoot(page, '00-main-editor.png'); console.log('[capture] spike OK'); return; }

        // 1. Shell / interface tour. A surface is selected on purpose: with nothing selected the
        // parameters column on the right is EMPTY, and a tour shot whose right-hand third is blank reads
        // as a broken app rather than as "this region fills when you select something". Every region of
        // the workbench should be populated in the one picture chapter 1 uses to name them.
        await safeShoot(page, '00-main-editor.png', async () => {
            await click(page, { text: 'Logo Wall', region: { maxLeft: 400 } }, { optional: true });
        });

        // 2. Surface selected → Inspector (content + transform)
        await safeShoot(page, '02-surface-inspector.png', async () => { await click(page, { text: 'Logo Wall', region: { maxLeft: 300 } }); });

        // 3. Fixture selected → Inspector (mapping / effect / geometry / 3D)
        await safeShoot(page, '03-fixture-inspector.png', async () => { await click(page, { text: 'LED Strip', region: { maxLeft: 300 } }); });

        // 4. The fixture docks — matrix selected. The seven-card "Fixture Editor" became TWO docks on
        // 2026-07-27 (plans/fixture-editor-split.md): "Library" and "Wiring & Ledmap".
        await safeShoot(page, '04-fixture-editor.png', async () => {
            await click(page, { text: 'Matrix 16x16', region: { maxLeft: 300 } });
            await clickText(page, 'Library', { optional: true });
        });

        // 5. Timeline dock
        await safeShoot(page, '05-timeline.png', async () => { await clickText(page, 'Timeline'); });

        // 6. Scenes & Cues dock
        // Scenes & Cues is a WORKBENCH now, not a tab whose label sits in the page text.
        await safeShoot(page, '06-scenes-cues.png', async () => { await goContext(page, 'scenes'); });
        await goContext(page, 'mapping');

        // 7. DMX Monitor dock
        await safeShoot(page, '07-dmx-monitor.png', async () => { await clickText(page, 'DMX Monitor'); });

        // restore Library as the default dock tab for later shots
        await clickText(page, 'Library', { optional: true });

        // 8. Media library (left tab — scope to the top-left so we don't hit the
        //    inspector's Media/Effect toggle which also reads "Media").
        // The old left-column "media" tab is gone; Media Library is a DOCK tab (and a browser panel).
        await safeShoot(page, '08-media-library.png', async () => { await clickText(page, 'Media Library'); });

        // 9. ⛔ NO 09-asset-manager.png. The separate Asset Manager panel was DELETED on 2026-07-23 and
        // folded into the Media Library — MediaPanel.tsx:244 says so in as many words ("this is what the
        // separate Asset Manager panel used to show; it lives here now so there is one [place]"). Shot 8
        // above IS the asset manager now. Capturing it was silently failing rather than telling anyone
        // the panel had gone.

        // 10. Routing (modal)
        await safeShoot(page, '10-routing.png', async () => { await clickTitle(page, 'Routing'); });
        await escClose(page);

        // 11. Outputs (modal) — then enable a Windowed output to reach the projector + calibration
        await safeShoot(page, '11-outputs.png', async () => { await clickTitle(page, 'Outputs'); });

        // 11b. Pick the "Windowed" display for Logo Wall and turn the output On — opens a real
        //      projector window we can screenshot, and unlocks Align/Calibrate.
        const projOpened = await page.evaluate(() => {
            const selects = [...document.querySelectorAll('select')];
            const disp = selects.find((s) => [...s.options].some((o) => /window/i.test(o.textContent)));
            if (!disp) return false;
            const opt = [...disp.options].find((o) => /window/i.test(o.textContent));
            disp.value = opt.value;
            disp.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        });
        await sleep(400);
        // toggle the first output's On checkbox
        await page.evaluate(() => {
            const cb = document.querySelector('input[type="checkbox"]');
            // find the On toggle inside the outputs table specifically
            const rows = [...document.querySelectorAll('input[type="checkbox"]')];
            if (rows[0]) { rows[0].click(); }
        });
        await sleep(1500);

        // 12. Outputs panel with a Windowed output enabled (Live status, Align unlocked).
        //     NB: the projector window itself is hardware-accelerated WebGL and captures
        //     black over CDP, so we document it via this editor-side view + the panel.
        await safeShoot(page, '11b-outputs-windowed.png');

        // 11c. Expanded output row — soft-edge (L/R/T/B + blend gamma), output gamma, and the
        //      Bézier-warp toggle, revealed by the row's "Warp / soft-edge / gamma" expander.
        await safeShoot(page, '11c-outputs-expanded.png', async () => {
            await clickTitle(page, 'Warp / soft-edge / gamma', { optional: true });
        });

        // 13. Calibration wizard (structured light). Open it, then close the Outputs
        //     overlay so the wizard is shown on its own.
        // The wizard is a PLUGIN surface, and the plugin is a launch profile (see the --calibrate note
        // at the spawn above). Assert it is really here: without it this step still "succeeds" and
        // writes a picture of whatever context was open, which is how the Mapping workbench once ended
        // up filed as the calibration chapter.
        const hasCalib = await page.evaluate(() => [...document.querySelectorAll('button')]
            .some((b) => /^Calibration/.test(b.getAttribute('title') || '')));
        if (!hasCalib) throw new Error('the Calibration workbench is absent — launch the capture with --calibrate, or 13-calibration.png will document the wrong screen');
        await safeShoot(page, '13-calibration.png', async () => {
            await clickTitle(page, 'Calibrate projector (structured light + pose)');
            await clickTitle(page, 'Close outputs', { optional: true });
            // ⚠ ASSERT THE WIZARD, NOT THE CLICK. The Calibrate button is GATED — it does nothing
            // unless the output is enabled AND bound to a live display — so on a machine with no
            // second display the click is silently inert and this step writes a picture of whatever
            // workbench was already open. It filed the Mapping context as the calibration chapter
            // twice before this check existed, with a ✓ on both runs. A wrong screenshot is worse
            // than a stale one: staleness is at least visible in the shell signature.
            const wizard = await page.evaluate(() => {
                const t = document.body.innerText || '';
                return /Auto[- ]Align/i.test(t) && /Setup/i.test(t);
            });
            if (!wizard) throw new Error('the calibration wizard did not open — the Calibrate button is gated on an output bound to a live display; connect one, or this chapter cannot be captured on this machine');
        });

        // Reset all transient overlays (wizard + windowed output) with a clean reload.
        await page.reload({ waitUntil: 'domcontentloaded' });
        page = await settleAfterReload(browser);
        await sleep(2500);

        // 14. Preferences (modal)
        // Preferences is a WORKBENCH now (the APP cluster on the rail), not a modal behind a title.
        await safeShoot(page, '14-preferences.png', async () => {
            await goContext(page, 'prefs');
            await redactPrivate(page);   // this card prints the machine's LAN URL + tablet PIN
        });
        await goContext(page, 'mapping');

        // 15. OSC Monitor (View ▸ OSC Monitor…)
        await safeShoot(page, '15-osc-monitor.png', async () => { await menuAction(page, 'View', 'OSC Monitor'); });
        await escClose(page);

        // 16. (retired) The Help side panel died with the TopBar icon group — help is one searchable
        // modal now (F1). Its shot joins the deferred whole-guide re-capture pass.

        // 17. About (Help ▸ About ArtLux)
        // The menu item is "About ARTLux" — the brand is set in caps there (src/main/menu.ts).
        await safeShoot(page, '17-about.png', async () => { await menuAction(page, 'Help', 'About ARTLux'); });
        await escClose(page);

        // 18. Audio Bed — the mixer (View ▸ Audio Bed…), for user-guide §7.
        //
        // A plugin modal, opened from the View menu — the same door as the OSC Monitor above, and it is
        // captured the same way. It renders WITHOUT the native audio addon: plugin.renderer.ts registers the
        // panel unconditionally, before the main-window gate, so a capture run on a machine with no
        // audio_engine.node still gets a complete, correct mixer (it will simply carry a `no audio engine`
        // badge — which is itself worth showing, and is exactly what the chapter documents).
        await sleep(400);   // let the About modal finish unmounting — menuAction is flaky over a closing dialog
        await safeShoot(page, '18-audio-bed.png', async () => { await menuAction(page, 'View', 'Audio Bed'); });
        await escClose(page);
        await sleep(300);

        // ── 19. THE CLIP INSPECTOR — NOT CAPTURED, AND HERE IS EXACTLY WHY ───────────────────────────────
        //
        // §7 would be better with a second shot showing the inspector filled in (gain, the spatial positioner
        // pad, the insert chain). It is NOT here, and this is deliberately a comment rather than a
        // permanently-failing safeShoot(): `safeShoot` swallows a failure with a ✗ and carries on, so a
        // context that can never succeed becomes a line of output nobody reads. (That is precisely how
        // `11c-outputs-expanded.png` and `12-3d-scene.png` spent months being "written by the script" and not
        // existing on disk.) A shot that cannot be taken should not pretend to be a shot that failed.
        //
        // WHAT IT WOULD TAKE. The inspector follows the TIMELINE SELECTION, so the sequence has to be:
        // open the Timeline dock → bind the GLOBAL document → maximize (F) → click the bed's clip → open the
        // panel. Three of those four are hostile to a script:
        //
        //   · A SCENE IS BOUND ON LOAD (applyProjectData binds the first one), and while a scene is bound THE
        //     BED'S LANES ARE NOT DRAWN AT ALL — by design, because the ruler belongs to that scene's playhead
        //     and the bed does not ride it. So the clip is not merely off-screen; it does not exist to click.
        //   · The Global pill is a DROPDOWN (`title="Choose which timeline to edit"`), not a button — and it
        //     only renders when the panel is handed an `author` prop, which it is not in every dock state.
        //   · A bare clickText('Global') matches "GLOBAL PARAMS" in the left panel and binds nothing.
        //
        // Every one of those is a real behaviour the chapter documents, which is a good sign for the app and
        // a bad one for the harness. Worth doing; not worth blocking the chapter on. The single 18-audio-bed
        // shot already carries the headline — two containers, the read-only scene tracks, the show clock, and
        // the master fader greyed out under its LANE badge.

        // 18. Dedicated 3D-scene shot for the user guide (§8, which otherwise reuses 00-main-editor).
        //     Select a fixture so the W/E/R transform gizmo shows in 3D, then clip to the in-window r3f
        //     pane (the right-most large canvas). Unlike the projector BrowserWindow, the embedded 3D
        //     canvas captures fine over CDP. Falls back to a full-window shot if the pane isn't found.
        try {
            await clickTitle(page, 'Show 3D scene (split view)', { optional: true }); // no-op if 3D already shown
            await click(page, { text: 'Matrix 16x16', region: { maxLeft: 300 } }, { optional: true });
            await sleep(700);
            const box = await page.evaluate(() => {
                const rects = [...document.querySelectorAll('canvas')]
                    .map((c) => c.getBoundingClientRect())
                    .filter((r) => r.width > 140 && r.height > 140);
                if (!rects.length) return null;
                rects.sort((a, b) => (b.left + b.width / 2) - (a.left + a.width / 2)); // right-most large canvas = 3D viewport
                const r = rects[0];
                return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
            });
            const file = path.join(OUT_DIR, '12-3d-scene.png');
            await page.screenshot(box ? { path: file, clip: box } : { path: file });
            console.log(`[capture]   ✓ 12-3d-scene.png${box ? ' (3D pane)' : ' (full window)'}`);
        } catch (e) { console.warn(`[capture]   ✗ 12-3d-scene.png — ${e.message}`); }

        // Stamp what these pictures were taken against, so their staleness can be MEASURED rather than
        // remembered. The old mechanism was a hand-written "⚠ these are outdated" banner in the guide,
        // which someone had to think to add and then think to remove — it survived three shell
        // generations. `verify:docs` recomputes this and says when it has moved.
        const stamp = {
            capturedAt: new Date().toISOString().slice(0, 10),
            appVersion: require(path.join(ROOT, 'package.json')).version,
            shellSignature: shellSignature(),
        };
        fs.writeFileSync(path.join(OUT_DIR, 'captured.json'), JSON.stringify(stamp, null, 2) + '\n');
        console.log(`[capture] stamped: v${stamp.appVersion}, shell ${stamp.shellSignature}`);

        console.log('[capture] done.');
    } finally {
        // Restore the user's original last project so their app reopens it normally.
        try {
            if (browser && origLastProject !== undefined) {
                const pages = await browser.pages();
                const page = pages.find((p) => p.url().includes(DEV_URL_HINT));
                if (page) await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), origLastProject);
                console.log(`[capture] restored lastProjectPath: ${origLastProject}`);
            }
        } catch (e) { console.warn('[capture] could not restore prefs:', e.message); }
        if (browser) { try { await browser.disconnect(); } catch {} }
        killTree(child.pid);
        if (process.platform === 'win32') { try { execSync('taskkill /im electron.exe /T /F', { stdio: 'ignore' }); } catch {} }
    }
}

main().catch((e) => { console.error('[capture] FAILED:', e.message); process.exit(1); });
