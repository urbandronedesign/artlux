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

    const sId = 'srf-logo', fxId = 'srf-fx';
    const stripId = 'fix-strip', matrixId = 'fix-matrix';
    const ctrlId = 'ctrl-main';
    const layA = 'lay-a', layB = 'lay-b';

    const project = {
        version: '1.1',
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
        scenes: [ { id: 'scn-a', name: 'Look A', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, groups: [] } ],
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
        },
        assets: [
            { id: 'ast-logo', name: 'logo.png', type: 'image', path: logo, width: 512, height: 512, addedAt: '2026-06-30T00:00:00.000Z' },
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
    const child = spawn(bin, ['dev'], {
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
        const page = await findRendererTarget(browser, 30000);
        await page.waitForFunction(() => document.body && /Surfaces|Fixtures/i.test(document.body.innerText), { timeout: 60000 });

        // Back up the user's last project, point the app at the demo, reload.
        origLastProject = await page.evaluate(async () => (await window.artlux.getPrefs())?.lastProjectPath ?? null);
        console.log(`[capture] backing up lastProjectPath: ${origLastProject}`);
        await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), demo);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => /Logo Wall|FX Panel/i.test(document.body.innerText), { timeout: 60000 });
        await sleep(2500); // let media decode + first paint settle
        console.log('[capture] demo loaded, capturing contexts …');

        if (SPIKE) { await shoot(page, '00-main-editor.png'); console.log('[capture] spike OK'); return; }

        // 1. Shell / interface tour (nothing selected)
        await safeShoot(page, '00-main-editor.png');

        // 2. Surface selected → Inspector (content + transform)
        await safeShoot(page, '02-surface-inspector.png', async () => { await click(page, { text: 'Logo Wall', region: { maxLeft: 300 } }); });

        // 3. Fixture selected → Inspector (mapping / effect / geometry / 3D)
        await safeShoot(page, '03-fixture-inspector.png', async () => { await click(page, { text: 'LED Strip', region: { maxLeft: 300 } }); });

        // 4. Fixture Editor dock — matrix selected (geometry + wiring card)
        await safeShoot(page, '04-fixture-editor.png', async () => {
            await click(page, { text: 'Matrix 16x16', region: { maxLeft: 300 } });
            await clickText(page, 'Fixture Editor', { optional: true });
        });

        // 5. Timeline dock
        await safeShoot(page, '05-timeline.png', async () => { await clickText(page, 'Timeline'); });

        // 6. Scenes & Cues dock
        await safeShoot(page, '06-scenes-cues.png', async () => { await clickText(page, 'Scenes & Cues'); });

        // 7. DMX Monitor dock
        await safeShoot(page, '07-dmx-monitor.png', async () => { await clickText(page, 'DMX Monitor'); });

        // restore Fixture Editor as the default dock tab for later shots
        await clickText(page, 'Fixture Editor', { optional: true });

        // 8. Media library (left tab — scope to the top-left so we don't hit the
        //    inspector's Media/Effect toggle which also reads "Media").
        await safeShoot(page, '08-media-library.png', async () => {
            await click(page, { text: 'media', exact: true, region: { maxLeft: 300, maxTop: 70 } });
        });

        // 9. Asset Manager (modal) — opened from the Media panel
        await safeShoot(page, '09-asset-manager.png', async () => { await clickTitle(page, 'Open full Asset Manager'); });
        await escClose(page);
        await click(page, { text: 'scene', exact: true, region: { maxLeft: 300, maxTop: 70 } }, { optional: true });

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
        await safeShoot(page, '13-calibration.png', async () => {
            await clickTitle(page, 'Calibrate projector (structured light + pose)');
            await clickTitle(page, 'Close outputs', { optional: true });
        });

        // Reset all transient overlays (wizard + windowed output) with a clean reload.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => /Logo Wall|FX Panel/i.test(document.body.innerText), { timeout: 60000 });
        await sleep(2500);

        // 14. Preferences (modal)
        await safeShoot(page, '14-preferences.png', async () => { await clickTitle(page, 'Preferences'); });
        await escClose(page);

        // 15. OSC Monitor (View ▸ OSC Monitor…)
        await safeShoot(page, '15-osc-monitor.png', async () => { await menuAction(page, 'View', 'OSC Monitor'); });
        await escClose(page);

        // 16. Help panel (side panel)
        await safeShoot(page, '16-help-panel.png', async () => { await clickTitle(page, 'Help (F1)'); });
        await clickTitle(page, 'Help (F1)', { optional: true }); // toggle back off

        // 17. About (Help ▸ About ArtLux)
        await safeShoot(page, '17-about.png', async () => { await menuAction(page, 'Help', 'About ArtLux'); });
        await escClose(page);

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
