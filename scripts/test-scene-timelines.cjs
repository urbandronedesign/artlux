// End-to-end test for per-scene decoupled timelines (CDP-driven, no committed binaries).
//
// Launches the dev build with the Chromium remote-debugging endpoint (ARTLUX_CDP_PORT, honoured by
// src/main/index.ts), seeds a deterministic 2-scene project into the OS temp dir, and drives the
// real renderer to verify the reported bug is fixed:
//   - on open, the timeline editor is bound to the CURRENT scene (initial-state scene), not "Global"
//   - selecting a scene in the pill shows THAT scene's own timeline (distinct per scene)
//   - (2026-11-20) a scene OWNS its timeline: there is no fallback to Global any more. Since
//     Scene.timeline became required, a missing one is normalized to an EMPTY timeline with no layers
//     (docs/SCENE-TIMELINES.md). So Scene A is seeded with its own one-layer, empty timeline, which is
//     what makes it editable here; the old "falls back to the global clip" assertion was removed.
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
// PREFS GUARD. The app persists LAYOUT to the prefs file as a test clicks around — which workbenches
// have the timeline drawer open, the current workbench — and restoring only lastProjectPath left the
// operator's layout changed after every run (found 2026-11-20: a drawer a previous harness opened in
// Venue & Rig covered the rows the next harness clicked). Back the WHOLE file up before launch and put
// it back once the app is dead, as test-engine-output and test-lighting-take already do.
const PREFS_FILE = path.join(process.env.APPDATA || require('node:os').homedir(), 'ArtLux', 'artlux-prefs.json');
const PREFS_BACKUP = (() => { try { return require('node:fs').readFileSync(PREFS_FILE); } catch { return null; } })();
function restorePrefs() {
    if (!PREFS_BACKUP) return;
    try { require('node:fs').writeFileSync(PREFS_FILE, PREFS_BACKUP); console.log('prefs restored'); }
    catch (e) { console.log(`prefs NOT restored (${e.message}) — backup was taken from ${PREFS_FILE}`); }
}
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9334';
const DEV_URL_HINT = 'localhost:3000';
const SHOTS = path.join(os.tmpdir(), 'artlux-scene-timeline-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Crafted project: global timeline + 2 scenes (A owns an EMPTY one-layer timeline; B owns a timeline
// with one clip), a state machine whose initial state binds Scene A, and cue cells.
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
        // Scene A: its own EMPTY timeline (one layer, no clips). Scene B: its own timeline with one clip.
        scenes: [
            { id: 'A', name: 'Scene A', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#f5a623', timeline: { ...emptyTl('A', 'unused', effect(1, 0)), clips: [] } },
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
        // Global timeline — the shared default. No scene falls back to it; it is edited via the pill.
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
        // The EDITOR page only. The splash (splash.html), the docs window and projector windows are served
        // from the same dev origin; matching the origin alone grabbed the SPLASH when it registered first,
        // which then closed under the test as "Attempted to use detached Frame" — an intermittent failure
        // that looked like a reload (found 2026-11-20 by logging framenavigated).
        for (const p of await browser.pages()) {
            const u = p.url();
            if (u.includes(DEV_URL_HINT) && !/(splash|docs|projector)\.html/.test(u)) return p;
        }
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
    await sleep(400);
    // Pick INSIDE the dropdown only: it is the container that lists "Global timeline". A page-wide text
    // match found another "Scene B" first (a parked panel still has a size) and the pill never moved.
    const item = await page.evaluate((lbl) => {
        const g = [...document.querySelectorAll('span')].find((s) => s.textContent.trim() === 'Global timeline');
        let box = g; while (box && ![...box.querySelectorAll('button')].some((b) => /Scene/.test(b.textContent))) box = box.parentElement;
        if (!box) return null;
        const b = [...box.querySelectorAll('button')].find((x) => {
            const name = [...x.querySelectorAll('span')].map((s) => s.textContent.trim());
            return name.includes(lbl) || x.textContent.trim() === lbl;
        });
        if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, label);
    if (!item) throw new Error(`pill dropdown entry "${label}" not found`);
    await page.mouse.click(item.x, item.y);
    await sleep(700);
    await discardStoreDialog(page);
}

// Recalling a scene while the live look differs from the stored one asks "Store your changes into
// <scene> first?" (shipped after this harness was written). The seeded scenes hold no captured look, so
// the dialog appears on every recall. Answer DISCARD: this test asserts timelines, and Update-scene
// would rewrite the very scenes it is measuring. Optional, because a recall with no change asks nothing.
async function discardStoreDialog(page) {
    const b = await page.evaluate(() => {
        const x = [...document.querySelectorAll('button')].find((e) => /^Discard\s*&\s*continue$/i.test((e.innerText || '').replace(/\s+/g, ' ').trim()));
        if (!x) return null; const r = x.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (b) { await page.mouse.click(b.x, b.y); await sleep(700); }
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
    await discardStoreDialog(page);
}

// THE TIMELINE IS A DRAWER (CLAUDE.md), collapsed to a strip by default, and its open state is banked
// PER CONTEXT. Its toggle is `button[aria-controls="workspace-bottom"]`. Until 88264e6 it was NOT
// hit-testable (the timeline was drawn over the strip and a mouse click hit its toolbar — the bug this
// harness surfaced); fixed, but a DOM click() stays: it tests timelines, not the toggle, and it cannot
// be intercepted by an overlay. Proof via aria-expanded. Never Ctrl+T blind: it toggles.
async function openTimeline(page) {
    const state = await page.evaluate(() => {
        const b = document.querySelector('button[aria-controls="workspace-bottom"]');
        if (!b) return 'missing';
        if (b.getAttribute('aria-expanded') !== 'true') b.click();
        return 'ok';
    });
    if (state === 'missing') throw new Error('timeline drawer toggle not found');
    await page.waitForFunction(
        () => document.querySelector('button[aria-controls="workspace-bottom"]')?.getAttribute('aria-expanded') === 'true',
        { timeout: 5000 });
    await sleep(800);
}

// Switch workbench via its rail button (title "Scenes & Cues — …"); the rail shows only the short title.
async function goContext(page, title) {
    const box = await page.evaluate((t) => {
        const b = [...document.querySelectorAll('button[title]')].find((x) => x.title.startsWith(t + ' —'));
        if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, title);
    if (!box) throw new Error(`rail button "${title}" not found`);
    await page.mouse.click(box.x, box.y);
    await sleep(900);
}

// Right-click the BODY of the first track row and pick Effect in the "Add clip" menu. Rows are found
// by their sticky gutter cell, the reliable handle (see test-timeline-rightclick.cjs), so this works on
// an EMPTY lane, which is what a scene's own fresh timeline is.
async function addEffectClip(page) {
    const spot = await page.evaluate(() => {
        const sc = [...document.querySelectorAll('div.overflow-auto')].find((d) => /Tracks/.test(d.innerText || ''));
        if (!sc) return null;
        const sr = sc.getBoundingClientRect();
        // A TRACK row, not the state-machine strip above the tracks: a track's gutter holds its name in an
        // <input> (the state strip's says "disabled · edit" and has none).
        const row = [...sc.querySelectorAll('div')]
            .filter((d) => { const cs = (d.className || '').toString(); return /sticky/.test(cs) && /left-0/.test(cs) && d.querySelector('input'); })
            .map((d) => d.getBoundingClientRect())
            .find((r) => r.height > 12 && r.y > sr.y + 22 && r.y + Math.min(r.height, 26) < sr.bottom - 2);
        if (!row) return null;
        return { x: Math.round(sr.x + 420), y: Math.round(row.y + Math.min(row.height, 26) / 2) };
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
    await sleep(600);
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
        page.on('console', (m) => { if (m.type() === 'error') console.log(`[page-console-error] ${m.text()}`); });        await page.waitForFunction(() => document.body && /Surfaces|Fixtures/i.test(document.body.innerText), { timeout: 60000 });

        orig = await page.evaluate(async () => (await window.artlux.getPrefs())?.lastProjectPath ?? null);
        await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), proj);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.body && /Surfaces|Fixtures/i.test(document.body.innerText), { timeout: 60000 });
        await sleep(2500);

        // Open the timeline drawer.
        await openTimeline(page);
        await shoot(page, '01-loaded-timeline.png');

        // 1. On load, the editor is bound to the current scene (initial-state scene = Scene A), not Global.
        const pill1 = await readPill(page);
        check('load binds to current scene (initial state), not Global', pill1 === 'Scene A', `pill = ${JSON.stringify(pill1)}`);

        // 2. Scene A shows ITS OWN (empty) timeline — no fallback to Global.
        const clipsA0 = await readClips(page);
        check('Scene A shows its own empty timeline, not the global clip', sameSet(clipsA0, []), `clips = ${JSON.stringify(clipsA0)}`);

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
        check('editing Scene A attaches the new clip to Scene A', sameSet(clipsAedit, ['Effect']), `clips = ${JSON.stringify(clipsAedit)}`);

        // 6. KEY: the edit must NOT have leaked into the global timeline.
        await pickPill(page, 'Global timeline');
        await sleep(500); await shoot(page, '04-global-after-edit.png');
        const clipsGafter = await readClips(page);
        check('edit did NOT leak into the global timeline', sameSet(clipsGafter, ['GlobalClip']), `clips = ${JSON.stringify(clipsGafter)}`);

        // 7. Scene A retained its own edited timeline.
        await pickPill(page, 'Scene A');
        await sleep(500);
        const clipsAback = await readClips(page);
        check('Scene A retained its edited timeline', sameSet(clipsAback, ['Effect']), `clips = ${JSON.stringify(clipsAback)}`);

        // 8. Follows GO: trigger Scene B from the Scenes/Cues panel → editor follows.
        await goContext(page, 'Scenes & Cues');
        await goScene(page, 'Scene B');
        await openTimeline(page);   // the drawer's open state is banked per context
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
        restorePrefs();   // after the app is dead, so nothing writes over it
    }
}
main();
