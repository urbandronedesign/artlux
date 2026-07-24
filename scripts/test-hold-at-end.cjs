// End-to-end test for the state-end HOLD (Timeline.holdAtEnd) and the `requireEnd` transition guard.
//
// The claim under test is not "the playhead stops" — the plain end-stop already did that. It is:
//
//   THE STATE'S PICTURE ENDS AND THE SHOW DOES NOT.
//
// i.e. the playhead parks on the last frame while `playing` stays TRUE, so the show clock (and with it
// the audio bed and the global automation) keeps advancing underneath — and the state machine is told,
// so a transition marked "only after the state has finished" becomes fireable at exactly that moment.
// Every one of those is invisible to a typechecker and to the build, so it is asserted here against the
// real renderer: launch the dev build with the Chromium remote-debugging endpoint (ARTLUX_CDP_PORT),
// seed a crafted project into the OS temp dir, and read the running UI.
//
// The bed's position readout (♪ BED) is the witness for "the show kept running": it is painted from
// the SHOW clock, which is gated on `playing`. If the hold ever emitted the end-stop's `pause`, that
// number freezes with the playhead and this test fails — which is the regression that matters, because
// in a venue its only symptom is that the room goes quiet.
//
// Launch/connect/cleanup plumbing is lifted from scripts/test-scene-timelines.cjs.
//
// Usage:  node scripts/test-hold-at-end.cjs

const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9335';
const DEV_URL_HINT = 'localhost:3000';
const SHOTS = path.join(os.tmpdir(), 'artlux-hold-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Crafted project.
//
// ONE scene, "Held", whose timeline runs to an out-point of 3 s with holdAtEnd ON, plus a second
// scene "Next" it can advance to. The graph starts in Held and carries TWO manual edges out of it:
// one plain, one with requireEnd — so the guard can be observed as the difference between them
// rather than inferred. The state's own clip is an EFFECT, so nothing has to decode from disk and the
// cold-start gate arms immediately (no media, nothing to wait for).
//
// The GLOBAL timeline is long (120 s) and NOT looping: the show clock therefore has plenty of room to
// keep advancing after the scene's 3 s are up, which is exactly what the bed readout is watched for.
// ---------------------------------------------------------------------------
function buildProject() {
    const dir = path.join(os.tmpdir(), 'artlux-hold-proj');
    fs.mkdirSync(dir, { recursive: true });
    const effect = (effectId, paletteId) => ({ type: 'EFFECT', effectId, paletteId, speed: 0.5, intensity: 0.8 });
    const tl = (id, clipName, eff, extra) => ({
        layers: [{ enabled: true, id: `${id}-L`, name: `${id} L`, height: 80 }],
        clips: [{ id: `${id}-clip`, layerId: `${id}-L`, name: clipName, content: eff, path: '', start: 0, duration: 20, inPoint: 0 }],
        duration: 30, fps: 30, markers: [], inPoint: null, outPoint: null, loop: false, trackingTakes: [],
        boundedDuration: true, ...extra,
    });
    const project = {
        version: '1.1', timestamp: '2026-07-24T00:00:00.000Z',
        surfaces: [{ id: 'srf', name: 'Stage', x: 0.1, y: 0.1, width: 0.8, height: 0.8, rotation: 0, zIndex: 0, content: { type: 'LAYER', layerId: 'HELD-L' } }],
        fixtures: [],
        controllers: [{ id: 'ctrl', name: 'Main', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, priority: 100, startUniverse: 0 }],
        globalBrightness: 1, groups: [],
        // The SHOW's own document: long and non-looping, so the show clock keeps climbing through the hold.
        timeline: { ...tl('G', 'GlobalClip', effect(1, 0)), duration: 120 },
        scenes: [
            // out-point 12 s + holdAtEnd ⇒ the state ends at 12 s and freezes there. TWELVE, not three:
            // the 'before the end' read below happens ~4 s after the project loads (reload + boot gate +
            // opening the workbench), and a 3 s state has already finished by then — the test would be
            // reading the HELD state and calling it 'before'.
            { id: 'HELD', name: 'Held', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#f5a623',
              timeline: tl('HELD', 'HeldClip', effect(2, 1), { outPoint: 12, holdAtEnd: true }) },
            { id: 'NEXT', name: 'Next', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#7ed957',
              timeline: tl('NEXT', 'NextClip', effect(3, 2)) },
        ],
        cueBanks: [{ id: 'bank1', name: 'Bank 1', rows: 8, cols: 16, cues: [], sceneCells: [] }],
        stateMachine: {
            enabled: true,
            initialStateId: 'stHeld',
            states: [
                { id: 'stHeld', name: 'Held', x: 140, y: 110, entry: [{ kind: 'play' }], sceneId: 'HELD' },
                { id: 'stNext', name: 'Next', x: 360, y: 110, entry: [], sceneId: 'NEXT' },
            ],
            // TWO edges out of Held, differing ONLY in the guard — the state-lane buttons for them are
            // what this test reads.
            transitions: [
                { id: 'gated', from: 'stHeld', to: 'stNext', trigger: { kind: 'manual' }, requireEnd: true },
                { id: 'free', from: 'stHeld', to: 'stNext', trigger: { kind: 'manual' } },
            ],
            regions: [],
        },
        assets: [],
    };
    const file = path.join(dir, 'hold.artlux');
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    return file;
}

// ---------------------------------------------------------------------------
// CDP plumbing (identical to test-scene-timelines.cjs)
// ---------------------------------------------------------------------------
function getJson(url) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 2000 }, (res) => {
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
async function shoot(page, name) { try { await page.screenshot({ path: path.join(SHOTS, name) }); } catch {} }

// ---------------------------------------------------------------------------
// In-page readers. All of these read what an OPERATOR sees, deliberately: the numbers behind them are
// engine singletons with no window handle, and a test that reached past the UI would not prove the
// operator can tell a held show from a hung one — which is half of what shipped here.
// ---------------------------------------------------------------------------

// The toolbar timecode ("HH:MM:SS:FF / HH:MM:SS:FF") — painted imperatively from the playhead.
const readTimecode = (page) => page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((e) => /^\d\d:\d\d:\d\d:\d\d \/ /.test(e.textContent || ''));
    return el ? el.textContent.trim() : null;
});
// The bed readout ("♪ BED m:ss") — painted from the SHOW clock, which is gated on `playing`.
const readBed = (page) => page.evaluate(() => {
    const el = [...document.querySelectorAll('span')].find((e) => /♪ BED/.test(e.textContent || ''));
    return el ? el.textContent.trim() : null;
});
// Is the transport reporting itself as playing? (the toolbar Play/Pause button carries the accent
// background while playing — the same signal the operator reads).
const readPlaying = (page) => page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((e) => (e.getAttribute('title') || '').startsWith('Play / Pause'));
    return b ? (b.className || '').includes('bg-accent') : null;
});
const readHolding = (page) => page.evaluate(() => !![...document.querySelectorAll('span')]
    .find((e) => (e.textContent || '').trim() === 'HOLDING'));
// The state lane's manual-trigger buttons, with their disabled state — the visible half of the guard.
const readStateButtons = (page) => page.evaluate(() => [...document.querySelectorAll('button')]
    .filter((b) => /^→ |Trigger →/.test(b.getAttribute('title') || ''))
    .map((b) => ({ title: b.getAttribute('title'), disabled: b.disabled })));
// The live current state, as shown in the state lane's gutter.
const readCurrentState = (page) => page.evaluate(() => {
    const lane = [...document.querySelectorAll('button')].find((b) => /State machine (ON|OFF)/.test(b.getAttribute('title') || ''));
    const gutter = lane?.parentElement;
    const label = gutter ? [...gutter.querySelectorAll('span')].find((s) => !/HOLDING/.test(s.textContent || '')) : null;
    return label ? label.textContent.trim() : null;
});

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const bedSeconds = (s) => { const m = /(\d+):(\d\d)/.exec(s || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };

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
    child.stdout.on('data', (d) => { const s = d.toString(); if (/error|fail/i.test(s)) process.stdout.write(`[dev] ${s}`); });
    child.stderr.on('data', (d) => process.stderr.write(`[dev:err] ${d}`));

    let browser, orig;
    try {
        const ver = await waitForCdp(120000);
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
        const page = await findRenderer(browser, 30000);
        page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));
        page.on('console', (m) => { if (m.type() === 'error') console.log(`[page-console-error] ${m.text()}`); });
        await page.waitForFunction(() => !!window.artlux && document.querySelectorAll('button').length > 3, { timeout: 60000 });

        orig = await page.evaluate(async () => (await window.artlux.getPrefs())?.lastProjectPath ?? null);
        await page.evaluate((p) => window.artlux.setPrefs({ lastProjectPath: p }), proj);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.artlux && document.querySelectorAll('button').length > 3, { timeout: 60000 });
        await sleep(2500);
        // The shell is context-driven: the left rail carries SHORT titles ('Time' for the Timeline
        // workbench), not the context's full name. Click the rail, not a tab.
        await clickByText(page, 'Time', { exact: true, wait: 900 });
        await sleep(600);

        // ── BEFORE the hold: the state is playing its 3 s and the gated edge must be refused. ───────
        const early = {
            tc: await readTimecode(page), playing: await readPlaying(page),
            holding: await readHolding(page), buttons: await readStateButtons(page),
        };
        await shoot(page, '01-playing.png');
        // requireEnd gates the AUTOMATIC path only — a human press ALWAYS fires. So the early button is
        // NOT disabled; it is FLAGGED (the ⏱ hint in its title) so the operator knows they are cutting
        // the state's picture and still gets to decide.
        const gatedEarly = early.buttons.find((b) => /cuts it|hasn't finished/.test(b.title));
        check('before the end, the guarded button is flagged early but still firable',
            !!gatedEarly && gatedEarly.disabled === false, `buttons = ${JSON.stringify(early.buttons)}`);
        check('before the end, the plain edge is offered', early.buttons.some((b) => !/cuts it|hasn't finished/.test(b.title) && !b.disabled),
            `buttons = ${JSON.stringify(early.buttons)}`);

        // ── Let the 12 s state run out, then watch the two clocks for 4 s. ───────────────────────────
        await sleep(12000);
        const t1 = await readTimecode(page), bed1 = await readBed(page), playing1 = await readPlaying(page);
        const holding = await readHolding(page);
        await shoot(page, '02-held.png');
        await sleep(4000);
        const t2 = await readTimecode(page), bed2 = await readBed(page), playing2 = await readPlaying(page);

        check('the playhead is HELD (frozen across 4 s)', !!t1 && t1 === t2, `t1 = ${t1}, t2 = ${t2}`);
        check('the transport is still PLAYING through the hold', playing1 === true && playing2 === true,
            `playing = ${playing1} → ${playing2}`);
        // THE REGRESSION THAT MATTERS: if the hold ever emits the end-stop's pause, this number freezes
        // with the playhead and the venue goes silent. Its only symptom in a room is the silence.
        const advanced = bedSeconds(bed2) - bedSeconds(bed1);
        check('the SHOW clock kept running (the bed does not stop)', Number.isFinite(advanced) && advanced >= 3,
            `bed ${bed1} → ${bed2} (+${advanced}s)`);
        check('the hold is visible to an operator (HOLDING chip)', holding === true, `chip = ${holding}`);

        // ── Once held, the "early" flag clears — the guard is satisfied, so a press is no longer a cut.
        const buttonsHeld = await readStateButtons(page);
        const gatedHeld = buttonsHeld.find((b) => /Trigger →/.test(b.title) && /Next/.test(b.title));
        check('once held, the guarded button is no longer flagged early', buttonsHeld.every((b) => !/cuts it|hasn't finished/.test(b.title)),
            `buttons = ${JSON.stringify(buttonsHeld)}`);

        // Firing it must actually advance the machine (the guard let it through, not merely un-greyed it).
        if (gatedHeld) {
            const box = await page.evaluate((title) => {
                const b = [...document.querySelectorAll('button')].find((e) => e.getAttribute('title') === title);
                if (!b) return null; const r = b.getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }, gatedHeld.title);
            if (box) { await page.mouse.click(box.x, box.y); await sleep(1200); }
        }
        await shoot(page, '03-advanced.png');
        const state = await readCurrentState(page);
        check('firing the guarded edge advances the machine', state === 'Next', `current state = ${JSON.stringify(state)}`);
        // …and leaving the state clears the hold: the incoming timeline plays from its first frame.
        const t3 = await readTimecode(page); await sleep(1200); const t4 = await readTimecode(page);
        check('leaving the held state re-arms the clock', !!t3 && t3 !== t4, `t3 = ${t3}, t4 = ${t4}`);

        // ── TRIGGER ZONES: the plugin's workbench tab, and a zone round-tripping into the project ───
        // Not a rule test (the rules are simulated frame-by-frame in scratch/zone-rules-sim.mjs, which
        // can script a person walking around; a UI harness cannot). This is the WIRING: the plugin's
        // panel reaches the Tracking context, and a zone drawn there lands in Scene3D — i.e. in the
        // project file — through the host service rather than in some plugin-local state.
        await clickByText(page, 'Track', { exact: true, wait: 900 });
        const zoneTab = await clickByText(page, 'Trigger Zones', { wait: 900, optional: true });
        check('the Trigger Zones panel reaches the Tracking workbench', zoneTab === true);
        if (zoneTab) {
            await shoot(page, '04-zones.png');
            const before = await page.evaluate(() => document.body.innerText.includes('drag on the map to draw a zone'));
            check('the zone map is mounted', before === true);
            await clickByText(page, 'Zone in the centre', { wait: 900, optional: true });
            const named = await page.evaluate(() => document.body.innerText.includes('Zone 1'));
            check('creating a zone adds it to the list', named === true);
            // …and it is APP state, not panel-local: leave the workbench and come back. The panel is
            // unmounted in between, so a zone that survives can only have been written through
            // host.scene3D.patch into the project — which is what makes it save and recall.
            await clickByText(page, 'Time', { exact: true, wait: 700 });
            await clickByText(page, 'Track', { exact: true, wait: 700 });
            await clickByText(page, 'Trigger Zones', { wait: 800, optional: true });
            const survived = await page.evaluate(() => document.body.innerText.includes('Zone 1'));
            check('the zone lives in the project, not in the panel', survived === true);
        }

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
