// End-to-end test for per-scene decoupled timelines (CDP-driven, no committed binaries).
//
// Launches the dev build with the Chromium remote-debugging endpoint (ARTLUX_CDP_PORT, honoured by
// src/main/index.ts), seeds a deterministic 2-scene project into the OS temp dir, and drives the
// real renderer to verify the reported bug is fixed:
//   - on open, the timeline editor is bound to the CURRENT scene (initial-state scene), not "Global"
//   - selecting a scene in the pill shows THAT scene's own timeline (distinct per scene)
//   - editing while a scene is current attaches to the scene and does NOT leak to the global timeline
//   - triggering a scene (GO) makes the editor follow it
//
// The user's own last-opened project is backed up and restored, so running this never changes which
// project the app reopens normally.
//
// Usage:  node scripts/test-scene-timelines.cjs

const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9334';
const DEV_URL_HINT = 'localhost:3000';
const SHOTS = path.join(os.tmpdir(), 'artlux-scene-timeline-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Crafted project: global timeline + 2 scenes (A has NO own timeline → falls back to global;
// B owns a distinct timeline), a state machine whose initial state binds Scene A, and cue cells.
// ---------------------------------------------------------------------------
function buildProject() {
    const dir = path.join(os.tmpdir(), 'artlux-scene-timeline-proj');
    fs.mkdirSync(dir, { recursive: true });
    const effect = (effectId, paletteId) => ({ type: 'EFFECT', effectId, paletteId, speed: 0.5, intensity: 0.8 });
    const emptyTl = (id, clipName, eff) => ({
        layers: [{ enabled: true, id: `${id}-L`, name: `${id} L`, height: 80 }],
        clips: [{ id: `${id}-clip`, layerId: `${id}-L`, name: clipName, content: eff, path: '', start: 0, duration: 6, inPoint: 0 }],
        duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [],
    });
    const project = {
        version: '1.1', timestamp: '2026-07-04T00:00:00.000Z',
        surfaces: [{ id: 'srf', name: 'Stage', x: 0.1, y: 0.1, width: 0.8, height: 0.8, rotation: 0, zIndex: 0, content: { type: 'NONE' } }],
        fixtures: [],
        controllers: [{ id: 'ctrl', name: 'Main', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, priority: 100, startUniverse: 0 }],
        settings: { artNetIp: '127.0.0.1', artNetPort: 6454, outputEnabled: false, broadcast: true, gamma: 1.2, protocol: 'artnet', fps: 44, keepAlive: true, artNetSync: true, oscEnabled: false, oscListenPort: 10000, oscListenAddress: '', oscControlPrefix: '/artlux', helpLang: 'en' },
        globalBrightness: 1, groups: [],
        // Scene A: NO own timeline (falls back to global). Scene B: its own distinct timeline.
        scenes: [
            { id: 'A', name: 'Scene A', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#f5a623' },
            { id: 'B', name: 'Scene B', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#7ed957', timeline: emptyTl('B', 'SceneBClip', effect(2, 1)) },
        ],
        cueBanks: [{ id: 'bank1', name: 'Bank 1', rows: 8, cols: 16, cues: [], sceneCells: [{ col: 0, sceneId: 'A' }, { col: 1, sceneId: 'B' }] }],
        stateMachine: {
            enabled: false,
            states: [
                { id: 'stA', name: 'Scene A', x: 140, y: 110, entry: [], sceneId: 'A' },
                { id: 'stB', name: 'Scene B', x: 320, y: 110, entry: [], sceneId: 'B' },
            ],
            transitions: [], initialStateId: 'stA', regions: [],
        },
        scene3D: { models: [], lightIntensity: 0.7, environment: false, exposure: 0.8, gridVisible: true, reflectiveFloor: true, trackingViz: false, trackingSmoothing: 0.6, trackingPredictMs: 50, trackingLabels: true, trackingMergePeople: false, trackingMergeRadius: 0.8 },
        // Global timeline — the shared default; Scene A falls back to this until it is edited.
        timeline: emptyTl('G', 'GlobalClip', effect(1, 0)),
        assets: [], projectorOutputs: [], projectorFpsCap: 30, projectorBrightness: 1,
    };
    const file = path.join(dir, 'scene-timeline-test.artlux');
    fs.writeFileSync(file, JSON.stringify(project, null, 2), 'utf-8');
    return file;
}

// ---------------------------------------------------------------------------
// CDP plumbing (same shape as scripts/capture-docs.cjs)
// ---------------------------------------------------------------------------
function getJson(url, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let body = ''; res.on('data', (c) => (body += c));
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout')));
    });
}
async function waitForCdp(deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        try { const ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); if (ver?.webSocketDebuggerUrl) return ver; } catch {}
        await sleep(800);
    }
    throw new Error(`CDP endpoint not reachable on :${CDP_PORT}`);
}
async function findRenderer(browser, deadlineMs) {
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
        for (const p of await browser.pages()) { const u = p.url(); if (u.includes(DEV_URL_HINT)) return p; }
        await sleep(500);
    }
    throw new Error('No renderer page target found');
}
function killTree(pid) {
    if (!pid) return;
    try { if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' }); else process.kill(-pid, 'SIGKILL'); } catch {}
}

// ---------------------------------------------------------------------------
// In-page helpers
// ---------------------------------------------------------------------------
async function clickByText(page, text, opts = {}) {
    const box = await page.evaluate((o) => {
        const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const cands = [...document.querySelectorAll('button,[role="tab"],a,li,div,span')].filter((e) => vis(e) && e.textContent);
        let m = cands.filter((e) => e.textContent.trim() === o.text);
        if (!m.length && !o.exact) m = cands.filter((e) => e.textContent.includes(o.text));
        m.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
        const el = m[0]; if (!el) return null; const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, { text, exact: !!opts.exact });
    if (!box) { if (opts.optional) return false; throw new Error(`clickByText: no match for "${text}"`); }
    await page.mouse.click(box.x, box.y);
    await sleep(opts.wait || 500);
    return true;
}

// The timeline "Editing:" pill label (scene name or "Global").
const readPill = (page) => page.evaluate(() => {
    const btn = document.querySelector('button[title="Choose which timeline to edit"]');
    if (!btn) return null;
    return btn.textContent.replace(/Editing:/i, '').trim();
});

// Names of the clip blocks currently rendered in the timeline lanes. Scope to ClipBlock elements
// (their root carries the `absolute top-1 bottom-1 rounded-sm` classes + a "Name — 0:06" title) so
// stray titles elsewhere in the app (e.g. a "Calibrate workspace" button) aren't mistaken for clips.
const readClips = (page) => page.evaluate(() => {
    return [...document.querySelectorAll('div[title]')]
        .filter((e) => { const c = e.className || ''; return c.includes('top-1') && c.includes('bottom-1') && c.includes('rounded-sm'); })
        .map((e) => (e.getAttribute('title') || '').split(' — ')[0].trim())
        .filter(Boolean);
});

// Open the pill dropdown and pick an entry by its visible label.
async function pickPill(page, label) {
    const btn = await page.evaluate(() => {
        const b = document.querySelector('button[title="Choose which timeline to edit"]');
        if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!btn) throw new Error('pill button not found');
    await page.mouse.click(btn.x, btn.y);
    await sleep(300);
    await clickByText(page, label, { exact: true, wait: 700 });
}

// Click the GO button inside the Scenes/Cues cell that contains a given scene name.
async function goScene(page, name) {
    const box = await page.evaluate((nm) => {
        const cells = [...document.querySelectorAll('div')].filter((d) => d.textContent && d.textContent.includes(nm));
        // deepest cell that contains a GO button
        for (const c of cells.sort((a, b) => a.textContent.length - b.textContent.length)) {
            const go = [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === 'GO');
            if (go) { const r = go.getBoundingClientRect(); if (r.width > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
        }
        return null;
    }, name);
    if (!box) throw new Error(`GO for "${name}" not found`);
    await page.mouse.click(box.x, box.y);
    await sleep(600);
}

// Right-click an empty part of the first lane and add an EFFECT clip via the content menu.
async function addEffectClip(page) {
    const spot = await page.evaluate(() => {
        const clip = [...document.querySelectorAll('[title]')].find((e) => / — \d/.test(e.getAttribute('title') || ''));
        if (!clip) return null; const r = clip.getBoundingClientRect();
        return { x: r.right + 220, y: r.top + r.height / 2 }; // empty lane area to the right of a clip
    });
    if (!spot) throw new Error('no clip found to locate a lane');
    await page.mouse.click(spot.x, spot.y, { button: 'right' });
    await sleep(400);
    await clickByText(page, 'Effect', { exact: true, wait: 600 });
}

async function shoot(page, name) {
    try { await page.screenshot({ path: path.join(SHOTS, name) }); } catch {}
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

// ---------------------------------------------------------------------------
async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });
    const proj = buildProject();
    console.log(`[test] project: ${proj}`);
    console.log(`[test] screenshots: ${SHOTS}`);

    const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT };
    delete env.ELECTRON_RUN_AS_NODE;
    const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite');
    console.log(`[test] launching dev (CDP :${CDP_PORT}) …`);
    const child = spawn(bin, ['dev'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
    child.stdout.on('data', (d) => { const s = d.toString(); if (/error|warn|fail/i.test(s)) process.stdout.write(`[dev] ${s}`); });
    child.stderr.on('data', (d) => process.stderr.write(`[dev:err] ${d}`));

    let browser, orig;
    try {
        const ver = await waitForCdp(120000);
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
        const page = await findRenderer(browser, 30000);
        page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') console.log(`[page-console-error] ${m.text()}`); });
        await page.waitForFunction(() => document.body && /Surfaces|Fixtures/i.test(document.body.innerText), { timeout: 60000 });

        orig = await page.evaluate(async () => (await window.artlux.getPrefs())?.lastProjectPath ?? null);
        await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), proj);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body && /Surfaces|Fixtures/i.test(document.body.innerText), { timeout: 60000 });
        await sleep(2500);

        // Open the Timeline dock.
        await clickByText(page, 'Timeline', { wait: 800 });
        await sleep(800);
        await shoot(page, '01-loaded-timeline.png');

        // 1. On load, the editor is bound to the current scene (initial-state scene = Scene A), not Global.
        const pill1 = await readPill(page);
        check('load binds to current scene (initial state), not Global', pill1 === 'Scene A', `pill = ${JSON.stringify(pill1)}`);

        // 2. Scene A has no own timeline → falls back to the global timeline's clips.
        const clipsA0 = await readClips(page);
        check('Scene A (no own tl) shows global fallback clips', sameSet(clipsA0, ['GlobalClip']), `clips = ${JSON.stringify(clipsA0)}`);

        // 3. Pill → Scene B shows B's OWN distinct timeline.
        await pickPill(page, 'Scene B');
        await sleep(600); await shoot(page, '02-sceneB.png');
        const pillB = await readPill(page);
        const clipsB = await readClips(page);
        check('pill → Scene B binds Scene B', pillB === 'Scene B', `pill = ${JSON.stringify(pillB)}`);
        check('Scene B renders its OWN timeline', sameSet(clipsB, ['SceneBClip']), `clips = ${JSON.stringify(clipsB)}`);

        // 4. Pill → Global shows the global timeline.
        await pickPill(page, 'Global timeline');
        await sleep(500);
        const clipsG = await readClips(page);
        check('pill → Global shows the global timeline', sameSet(clipsG, ['GlobalClip']), `clips = ${JSON.stringify(clipsG)}`);

        // 5. Pill → Scene A, then edit (add an Effect clip). It must attach to Scene A.
        await pickPill(page, 'Scene A');
        await sleep(500);
        await addEffectClip(page);
        await sleep(600); await shoot(page, '03-sceneA-edited.png');
        const clipsAedit = await readClips(page);
        check('editing Scene A attaches the new clip to Scene A', sameSet(clipsAedit, ['GlobalClip', 'Effect']), `clips = ${JSON.stringify(clipsAedit)}`);

        // 6. KEY: the edit must NOT have leaked into the global timeline.
        await pickPill(page, 'Global timeline');
        await sleep(500); await shoot(page, '04-global-after-edit.png');
        const clipsGafter = await readClips(page);
        check('edit did NOT leak into the global timeline', sameSet(clipsGafter, ['GlobalClip']), `clips = ${JSON.stringify(clipsGafter)}`);

        // 7. Scene A retained its own edited timeline.
        await pickPill(page, 'Scene A');
        await sleep(500);
        const clipsAback = await readClips(page);
        check('Scene A retained its edited timeline', sameSet(clipsAback, ['GlobalClip', 'Effect']), `clips = ${JSON.stringify(clipsAback)}`);

        // 8. Follows GO: trigger Scene B from the Scenes/Cues panel → editor follows.
        await clickByText(page, 'Scenes & Cues', { wait: 700 });
        await sleep(500);
        await goScene(page, 'Scene B');
        await clickByText(page, 'Timeline', { wait: 700 });
        await sleep(600); await shoot(page, '05-after-go-B.png');
        const pillAfterGo = await readPill(page);
        check('editor follows GO (→ Scene B)', pillAfterGo === 'Scene B', `pill = ${JSON.stringify(pillAfterGo)}`);
        const clipsAfterGo = await readClips(page);
        check('after GO, Scene B timeline is shown', sameSet(clipsAfterGo, ['SceneBClip']), `clips = ${JSON.stringify(clipsAfterGo)}`);

        console.log('');
        const failed = results.filter((r) => !r.pass);
        console.log(`[test] ${results.length - failed.length}/${results.length} checks passed`);
        process.exitCode = failed.length ? 1 : 0;
    } catch (e) {
        console.error('[test] ERROR:', e.stack || e.message);
        process.exitCode = 2;
    } finally {
        try { if (browser && orig !== undefined) { const pages = await browser.pages(); const page = pages.find((p) => p.url().includes(DEV_URL_HINT)); if (page) await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), orig); } } catch {}
        if (browser) { try { await browser.disconnect(); } catch {} }
        killTree(child.pid);
        if (process.platform === 'win32') { try { execSync('taskkill /im electron.exe /T /F', { stdio: 'ignore' }); } catch {} }
    }
}
main();
