// End-to-end test for TRIGGER ZONES driving the show machine: zone combinations (ALL/ANY/NOT), global
// rules (SmTransition.fromAny), per-scene zone selection, and the fact that a GO no longer wipes the
// room's zones.
//
// It drives REAL BLOBS OVER UDP in the venue's own OSC protocol — the same wire the LiDAR server uses —
// so the whole path is exercised: udp → main → onOscMessage → trackingStore → zones.evaluate →
// zoneTriggers → SmContext.pluginTrigger → tick() → a scene recall. Nothing is stubbed and nothing is
// reached past the UI. (The blob positions are scripted rather than orbited, which is why this does not
// just spawn scripts/lidar-emitter.cjs — but the 12-line OSC encoder below is lifted from it.)
//
// Launch/connect/cleanup plumbing is lifted from scripts/test-hold-at-end.cjs.
//
// Usage:  node scripts/test-zone-fsm.cjs

const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9336';
const OSC_PORT = 10000;
const DEV_URL_HINT = 'localhost:3000';
const SHOTS = path.join(os.tmpdir(), 'artlux-zone-fsm-test');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The venue's OSC protocol (encoder lifted from scripts/lidar-emitter.cjs) ─────────────────────
const sock = dgram.createSocket('udp4');
function padString(str) {
    const raw = Buffer.from(str, 'utf8');
    const len = (Math.floor(raw.length / 4) + 1) * 4;
    const b = Buffer.alloc(len); raw.copy(b); return b;
}
function osc(address, type, value) {
    const tags = padString(',' + type);
    const arg = Buffer.alloc(4);
    if (type === 'i') arg.writeInt32BE(value | 0); else arg.writeFloatBE(value);
    return Buffer.concat([padString(address), tags, arg]);
}
const fire = (address, type, value) => sock.send(osc(address, type, value), OSC_PORT, '127.0.0.1');

const SCALE_X = 5.825, SCALE_Y = 3.125;
// Place people at deliberate normalized positions on SOL. `people` is a list of {u,v}; every other slot
// is emptied with id=0, which is the protocol's "this slot is free" (trackingStore's leave signal).
function sendBlobs(people) {
    fire('/SOL/specs/Scalex', 'f', SCALE_X);
    fire('/SOL/specs/Scaley', 'f', SCALE_Y);
    for (let i = 0; i < 6; i++) {
        const p = people[i];
        if (!p) { fire(`/SOL/blobs/blob${i}/id`, 'i', 0); continue; }
        fire(`/SOL/blobs/blob${i}/id`, 'i', i + 1);
        fire(`/SOL/blobs/blob${i}/tx`, 'f', (p.u - 0.5) * SCALE_X);
        fire(`/SOL/blobs/blob${i}/ty`, 'f', (p.v - 0.5) * SCALE_Y);
        fire(`/SOL/blobs/blob${i}/u`, 'f', p.u);
        fire(`/SOL/blobs/blob${i}/v`, 'f', p.v);
    }
}
// Hold a configuration for `ms`, re-sent at ~30 Hz. The tracker is a continuous feed and the zone
// hysteresis is measured in wall time, so a single packet would be a blip, not a person standing there.
async function hold(people, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { sendBlobs(people); await sleep(33); }
}

// Two zones on SOL, side by side, with a gap so a person is unambiguously in one of them.
// THREE zones, and the third one is not padding: the global rule needs a zone of its OWN. With the
// global watching `stage`, the combination "entrance AND NOT stage" could never be tested — stepping
// into the stage to falsify the NOT term fires the global rule first, and the show leaves Idle for the
// wrong reason. (That is exactly what happened on the first run of this test.)
const ZONE_A = { id: 'zA', name: 'entrance', surface: 'SOL', u0: 0.05, v0: 0.55, u1: 0.32, v1: 0.95, color: '#f5a623', minBlobs: 1, enterSec: 0.2, exitSec: 0.4 };
const ZONE_B = { id: 'zB', name: 'stage', surface: 'SOL', u0: 0.38, v0: 0.55, u1: 0.65, v1: 0.95, color: '#22d3ee', minBlobs: 1, enterSec: 0.2, exitSec: 0.4 };
const ZONE_C = { id: 'zC', name: 'doorway', surface: 'SOL', u0: 0.70, v0: 0.55, u1: 0.95, v1: 0.95, color: '#a855f7', minBlobs: 1, enterSec: 0.2, exitSec: 0.4 };
const IN_A = { u: 0.18, v: 0.75 };
const IN_B = { u: 0.50, v: 0.75 };
const IN_C = { u: 0.82, v: 0.75 };
const NOWHERE = { u: 0.50, v: 0.10 };   // on the surface, inside no zone

// ---------------------------------------------------------------------------
// Crafted project.
//
//   Idle  ──[zone combo: entrance AND NOT stage]──▶  Combo
//   ⚡ global [stage: someone enters] ──▶ Global      (fires from ANY state)
//
// Scene "Combo" deliberately listens to BOTH zones; scene "Global" listens to NEITHER (activeZoneIds: [])
// so the last assertion can prove an inactive zone is inert.
// ---------------------------------------------------------------------------
function buildProject() {
    const dir = path.join(os.tmpdir(), 'artlux-zone-fsm-proj');
    fs.mkdirSync(dir, { recursive: true });
    const effect = (effectId, paletteId) => ({ type: 'EFFECT', effectId, paletteId, speed: 0.5, intensity: 0.8 });
    const tl = (id, name, eff) => ({
        layers: [{ enabled: true, id: `${id}-L`, name: `${id} L`, height: 80 }],
        clips: [{ id: `${id}-clip`, layerId: `${id}-L`, name, content: eff, path: '', start: 0, duration: 60, inPoint: 0 }],
        duration: 60, fps: 30, markers: [], inPoint: null, outPoint: null, loop: true, trackingTakes: [], boundedDuration: true,
    });
    // The ROOM lives on the project's scene3D. Each scene's own scene3D carries only `activeZoneIds` —
    // no `trackingZones` — which is exactly the shape App.buildSceneSnapshot now writes.
    const scene3D = { models: [], lightIntensity: 1, environment: true, exposure: 1, gridVisible: true, trackingViz: true, trackingZones: [ZONE_A, ZONE_B, ZONE_C] };
    const project = {
        version: '1.1', timestamp: '2026-07-24T00:00:00.000Z',
        surfaces: [{ id: 'srf', name: 'Stage', x: 0.1, y: 0.1, width: 0.8, height: 0.8, rotation: 0, zIndex: 0, content: { type: 'LAYER', layerId: 'IDLE-L' } }],
        fixtures: [],
        controllers: [{ id: 'ctrl', name: 'Main', protocol: 'artnet', ip: '127.0.0.1', broadcast: false, priority: 100, startUniverse: 0 }],
        globalBrightness: 1, groups: [],
        scene3D,
        timeline: tl('G', 'GlobalClip', effect(1, 0)),
        scenes: [
            { id: 'S_IDLE', name: 'Idle', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#f5a623', timeline: tl('IDLE', 'IdleClip', effect(1, 0)), scene3D: { ...scene3D, trackingZones: undefined } },
            { id: 'S_COMBO', name: 'Combo', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#7ed957', timeline: tl('COMBO', 'ComboClip', effect(2, 1)), scene3D: { ...scene3D, trackingZones: undefined } },
            // Listens to NOTHING — the inert-zone assertion.
            { id: 'S_GLOBAL', name: 'Global', fadeSec: 0, surfaces: [], fixtures: [], globalBrightness: 1, accent: '#a855f7', timeline: tl('GLOB', 'GlobClip', effect(3, 2)), scene3D: { ...scene3D, trackingZones: undefined, activeZoneIds: [] } },
        ],
        cueBanks: [{ id: 'bank1', name: 'Bank 1', rows: 8, cols: 16, cues: [], sceneCells: [] }],
        stateMachine: {
            enabled: true,
            initialStateId: 'stIdle',
            states: [
                { id: 'stIdle', name: 'Idle', x: 140, y: 110, entry: [], sceneId: 'S_IDLE' },
                { id: 'stCombo', name: 'Combo', x: 360, y: 110, entry: [], sceneId: 'S_COMBO' },
                { id: 'stGlobal', name: 'Global', x: 580, y: 110, entry: [], sceneId: 'S_GLOBAL' },
            ],
            transitions: [
                // entrance AND NOT stage — the combination.
                { id: 'combo', from: 'stIdle', to: 'stCombo', trigger: { kind: 'plugin', source: 'lidar.zone', params: { match: 'all', terms: [{ zone: 'zA' }, { zone: 'zB', not: true }] } } },
                // A GLOBAL rule: someone enters the stage zone → Global, from wherever the show is.
                { id: 'glob', from: '', to: 'stGlobal', fromAny: true, trigger: { kind: 'plugin', source: 'lidar.zone', params: { zoneId: 'zC', edge: 'enter' } } },
            ],
            regions: [],
        },
        assets: [],
    };
    const file = path.join(dir, 'zones.artlux');
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    return file;
}

// ── CDP plumbing ────────────────────────────────────────────────────────────────────────────────
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
        for (const p of await browser.pages()) if (p.url().includes(DEV_URL_HINT)) return p;
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
    await sleep(opts.wait || 400);
    return true;
}
const shoot = async (page, name) => { try { await page.screenshot({ path: path.join(SHOTS, name) }); } catch {} };

// The live current state, from the state lane's gutter.
const readState = (page) => page.evaluate(() => {
    const lane = [...document.querySelectorAll('button')].find((b) => /State machine (ON|OFF)/.test(b.getAttribute('title') || ''));
    const gutter = lane?.parentElement;
    const label = gutter ? [...gutter.querySelectorAll('span')].find((s) => !/HOLDING/.test(s.textContent || '')) : null;
    return label ? label.textContent.trim() : null;
});
// Zone names visible in the Trigger Zones panel — the witness for "a GO did not wipe the room".
const readZoneNames = (page) => page.evaluate(() => {
    const txt = document.body.innerText;
    return ['entrance', 'stage', 'doorway'].filter((n) => txt.includes(n));
});

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

// Wait until the machine reports `want`, up to `ms`, while holding a blob configuration.
async function waitForState(page, want, people, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        await hold(people, 300);
        if (await readState(page) === want) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
async function main() {
    fs.mkdirSync(SHOTS, { recursive: true });
    const proj = buildProject();
    console.log(`[test] project: ${proj}`);

    const env = { ...process.env, ARTLUX_CDP_PORT: CDP_PORT };
    delete env.ELECTRON_RUN_AS_NODE;
    const bin = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite');
    console.log(`[test] launching dev (CDP :${CDP_PORT}) …`);
    const child = spawn(bin, ['dev'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', detached: process.platform !== 'win32' });
    child.stdout.on('data', (d) => { const s = d.toString(); if (/error|fail/i.test(s)) process.stdout.write(`[dev] ${s}`); });
    child.stderr.on('data', (d) => process.stderr.write(`[dev:err] ${d}`));

    let browser, origProj, origSettings;
    try {
        const ver = await waitForCdp(120000);
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
        const page = await findRenderer(browser, 30000);
        page.on('pageerror', (e) => console.log(`[page-error] ${e.message}`));
        await page.waitForFunction(() => !!window.artlux && document.querySelectorAll('button').length > 3, { timeout: 60000 });

        // The OSC listener is a MACHINE setting (Prefs.appSettings), not project data — so it has to be
        // switched on here, and restored afterwards, exactly like lastProjectPath.
        const prefs = await page.evaluate(async () => await window.artlux.getPrefs());
        origProj = prefs?.lastProjectPath ?? null;
        origSettings = prefs?.appSettings ?? null;
        await page.evaluate((p, port) => window.artlux.setPrefs({
            lastProjectPath: p,
            appSettings: { ...(window.__origSettings || {}), oscEnabled: true, oscListenPort: port, oscListenAddress: '', oscControlPrefix: '/artlux' },
        }), proj, OSC_PORT);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => !!window.artlux && document.querySelectorAll('button').length > 3, { timeout: 60000 });
        await sleep(3000);
        await clickByText(page, 'Time', { exact: true, wait: 800 });

        const start = await readState(page);
        check('the show starts in Idle', start === 'Idle', `state = ${JSON.stringify(start)}`);

        // ── 1. THE COMBINATION — tested FIRST, and from Idle, while the global's zone is untouched.
        // Both zones occupied ⇒ the NOT term is false ⇒ "entrance AND NOT stage" must NOT fire.
        const firedWithBoth = await waitForState(page, 'Combo', [IN_A, IN_B], 3500);
        check('entrance AND NOT stage does NOT fire while both are occupied', firedWithBoth === false,
            `state = ${JSON.stringify(await readState(page))}`);

        // …now they step off the stage. The entrance is still occupied ⇒ the expression becomes true, and
        // arm-and-hold fires it on that frame.
        const firedWithA = await waitForState(page, 'Combo', [IN_A], 5000);
        check('…and fires the moment the stage empties', firedWithA === true,
            `state = ${JSON.stringify(await readState(page))}`);
        await shoot(page, '01-combo.png');

        // ── 2. THE GLOBAL RULE — from Combo, a state the edge was never drawn from ───────────────────
        // Nothing leaves Combo in this graph. The only way on is the global rule, watching `doorway`.
        await hold([NOWHERE], 800);
        const wentGlobal = await waitForState(page, 'Global', [IN_C], 5000);
        check('a global rule fires from a state it was never drawn from', wentGlobal === true,
            `state = ${JSON.stringify(await readState(page))}`);
        await shoot(page, '02-global.png');

        // ── 3. AN INACTIVE ZONE IS INERT ────────────────────────────────────────────────────────────
        // Scene "Global" listens to NO zones (activeZoneIds: []). Walking into the entrance must not fire
        // the combination from here — zA is unanswerable in this look, not "empty".
        await hold([NOWHERE], 800);
        const movedByInactive = await waitForState(page, 'Combo', [IN_A], 3500);
        check('a zone the current scene ignores cannot fire a rule', movedByInactive === false,
            `state = ${JSON.stringify(await readState(page))}`);

        // ── 4. THE ROOM SURVIVED EVERY GO ───────────────────────────────────────────────────────────
        // Three scene recalls have happened by now. Before the fix, the FIRST one wiped every zone.
        await clickByText(page, 'Track', { exact: true, wait: 800 });
        await clickByText(page, 'Trigger Zones', { wait: 900, optional: true });
        const names = await readZoneNames(page);
        await shoot(page, '03-zones-after-go.png');
        check('a GO does not wipe the room’s zones', names.length === 3, `zones present = ${JSON.stringify(names)}`);

        console.log('');
        const failed = results.filter((r) => !r.pass);
        console.log(`[test] ${results.length - failed.length}/${results.length} checks passed`);
        process.exitCode = failed.length ? 1 : 0;
    } catch (e) {
        console.error('[test] ERROR:', e.stack || e.message);
        process.exitCode = 2;
    } finally {
        try {
            if (browser) {
                const pages = await browser.pages();
                const page = pages.find((p) => p.url().includes(DEV_URL_HINT));
                if (page) await page.evaluate((p, s) => window.artlux.setPrefs({ lastProjectPath: p, appSettings: s ?? undefined }), origProj, origSettings);
            }
        } catch {}
        try { sock.close(); } catch {}
        if (browser) { try { await browser.disconnect(); } catch {} }
        killTree(child.pid);
        if (process.platform === 'win32') { try { execSync('taskkill /im electron.exe /T /F', { stdio: 'ignore' }); } catch {} }
    }
}
main();
