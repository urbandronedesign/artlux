// Runtime proof that the render/output engine is independent of the UI.
//
// `npm run verify` reads source, so it can assert that the code still LOOKS decoupled. It cannot
// assert that DMX still comes out — and every invariant in this area exists because something broke
// silently while the code compiled and the app booted. This is the other half: it drives the real app
// and watches the wire.
//
//   node scripts/test-engine-output.cjs [--project=<file>] [--keep]
//
// What it asserts, in order of how much it would hurt to lose:
//   1. a project loads and ArtDmx reaches the wire at all;
//   2. deleting the Stage's canvas AND its container out of the running DOM does not stop output —
//      this is the whole point of engine/frameEngine, and it was false before it existed;
//   3. touring every workspace context never drops output;
//   4. --headless outputs with NO view mounted anywhere.
//
// It writes its own project (a still image on a surface, one 60-LED fixture sampling it) so the result
// does not depend on whatever the operator last had open, and it points Art-Net at loopback on an
// unused port so it never collides with the app's own input socket on 6454. The operator's prefs are
// backed up and restored, including after a crash.

const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ARTNET_PORT = 6469;           // not 6454: the app's own Art-Net INPUT socket binds that
const CDP_PORT = process.env.ARTLUX_CDP_PORT || '9370';
const KEEP = process.argv.includes('--keep');
const projectArg = process.argv.find((a) => a.startsWith('--project='));
const PREFS = path.join(process.env.APPDATA || os.homedir(), 'ArtLux', 'artlux-prefs.json');
const WORK = path.join(os.tmpdir(), 'artlux-engine-output-test');
const PREFS_BAK = path.join(WORK, 'prefs.backup.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (u) => new Promise((res, rej) => { http.get(u, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }).on('error', rej); });
const gauge = (t, n) => { const m = new RegExp('^' + n + '(?:\\{[^}]*\\})?\\s+([0-9.eE+-]+)', 'm').exec(t.replace(/\r/g, '')); return m ? Number(m[1]) : null; };

let puppeteer = null;
try { puppeteer = require(path.join(ROOT, 'node_modules', 'puppeteer-core')); } catch { /* checked below */ }

// ---------------------------------------------------------------------------
// A self-contained project: one IMAGE surface, one fixture sampling it. An image
// rather than a video so the expected output is STABLE — a still should produce a
// near-constant channel sum, which distinguishes "a real picture" from noise.
// ---------------------------------------------------------------------------
function buildProject() {
    fs.mkdirSync(path.join(WORK, 'assets', 'images'), { recursive: true });
    const png = path.join(WORK, 'assets', 'images', 'swatch.png');
    if (!fs.existsSync(png)) fs.copyFileSync(path.join(ROOT, 'build', 'icon.png'), png);
    const file = path.join(WORK, 'engine-output-test.artlux');
    fs.writeFileSync(file, JSON.stringify({
        version: '1.2',
        timestamp: '2026-01-01T00:00:00.000Z',
        surfaces: [{ id: 'srf', name: 'Swatch', x: 0, y: 0, width: 1, height: 1, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: png, opacity: 1 } }],
        fixtures: [{ id: 'fix', name: 'Strip', surfaceId: 'srf', x: 0, y: 0.35, width: 1, height: 0.3, rotation: 0, ledCount: 60, universe: 0, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 }],
        controllers: [], groups: [], scenes: [], cueBanks: [],
    }, null, 2));
    return file;
}

function sniffer() {
    const s = { packets: 0, lit: 0, peak: 0 };
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (buf) => {
        if (buf.length < 18 || buf.toString('latin1', 0, 8) !== "Art-Net\u0000" || buf.readUInt16LE(8) !== 0x5000) return;
        const d = buf.subarray(18, 18 + Math.min(buf.readUInt16BE(16), 180));
        s.packets++;
        let max = 0;
        for (let i = 0; i < d.length; i++) if (d[i] > max) max = d[i];
        if (max > 0) s.lit++;
        if (max > s.peak) s.peak = max;
    });
    return { s, sock };
}

function launch(extraArgs, withCdp) {
    const env = { ...process.env };
    // Inheriting this makes Electron boot as plain Node — `electron.app` is undefined and main dies
    // before any window exists. A documented gotcha; see docs/DEVELOPMENT.md.
    delete env.ELECTRON_RUN_AS_NODE;
    if (withCdp) env.ARTLUX_CDP_PORT = CDP_PORT;
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '--', '--', ...extraArgs], {
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

    let child = null, browser = null;
    try {
        // Point output at loopback so the wire is observable, preserving everything else.
        const prefs = hadPrefs ? JSON.parse(fs.readFileSync(PREFS, 'utf8')) : {};
        prefs.appSettings = { ...(prefs.appSettings || {}), outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: ARTNET_PORT, broadcast: false, protocol: 'artnet' };
        fs.writeFileSync(PREFS, JSON.stringify(prefs, null, 2));

        console.log('project :', project);
        console.log('art-net :', `127.0.0.1:${ARTNET_PORT}`);

        // ── EDITOR ──────────────────────────────────────────────────────────────────────────────
        const { s: wire, sock } = sniffer();
        await new Promise((r) => sock.bind(ARTNET_PORT, '0.0.0.0', r));
        child = launch([`--project=${project}`], true);

        let ver = null;
        for (let i = 0; i < 180 && !ver; i++) { try { ver = JSON.parse(await get(`http://127.0.0.1:${CDP_PORT}/json/version`)); } catch { await sleep(1000); } }
        if (!ver) throw new Error('the app never came up on CDP');
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
        let page = null;
        for (let i = 0; i < 40 && !page; i++) {
            for (const p of await browser.pages()) { const u = p.url(); if (/localhost:3000/.test(u) && !/projector|splash|docs/.test(u)) { page = p; break; } }
            if (!page) await sleep(1000);
        }
        if (!page) throw new Error('no renderer target found');
        await sleep(26000); // boot + project load + the cold-start decode gate

        // Only PACKETS are asserted, not brightness. What is being proved here is that the pipeline
        // runs end to end; whether the sampled band happens to be lit depends on the test asset (the
        // app icon has transparent regions, so a dark reading is legitimate and not a failure).
        console.log('\n1. output reaches the wire');
        wire.packets = 0; wire.lit = 0;
        await sleep(6000);
        note(wire.packets > 0, 'ArtDmx on the wire', `${wire.packets} packets (${wire.lit} lit — informational)`);

        console.log('\n2. output survives the Stage being torn out of the DOM');
        const removed = await page.evaluate(() => {
            const c = document.querySelector('canvas[width="512"][height="512"]');
            if (!c) return 'no stage canvas found';
            const host = c.closest('div');
            c.remove();
            if (host && host.parentElement) host.parentElement.removeChild(host);
            return 'removed';
        });
        if (removed !== 'removed') note(false, 'Stage DOM removal', removed);
        else {
            wire.packets = 0;
            await sleep(6000);
            const m = await get('http://127.0.0.1:9464/metrics').catch(() => '');
            note(wire.packets > 0, 'output continues with no Stage in the DOM',
                `${wire.packets} packets · native ${gauge(m, 'artlux_output_fps')} Hz`);
        }

        console.log('\n3. every workspace context, with output running');
        const rails = await page.evaluate(() => [...document.querySelectorAll('[role="tablist"] button')].map((b) => (b.textContent || '').trim()).filter(Boolean));
        let worst = Infinity;
        for (const name of rails) {
            await page.evaluate((n) => {
                const b = [...document.querySelectorAll('[role="tablist"] button')].find((x) => (x.textContent || '').trim() === n);
                if (b) b.click();
            }, name);
            await sleep(1800);
            const m = await get('http://127.0.0.1:9464/metrics').catch(() => '');
            worst = Math.min(worst, gauge(m, 'artlux_output_fps') ?? 0);
        }
        note(worst > 0, 'output never dropped across a full context tour', `worst ${worst} Hz over ${rails.length} contexts`);

        try { await browser.disconnect(); } catch { /* ignore */ }
        browser = null;
        await stop(child);
        sock.close();

        // ── HEADLESS: no view mounted at all ────────────────────────────────────────────────────
        console.log('\n4. headless, which renders no view whatsoever');
        const h = sniffer();
        await new Promise((r) => h.sock.bind(ARTNET_PORT, '0.0.0.0', r));
        child = launch(['--headless', `--project=${project}`], false);
        await sleep(30000);
        h.s.packets = 0;
        await sleep(6000);
        const hm = await get('http://127.0.0.1:9464/metrics').catch(() => '');
        note(h.s.packets > 0, 'headless outputs with no Stage anywhere',
            `${h.s.packets} packets · native ${gauge(hm, 'artlux_output_fps')} Hz · mode ${(/^artlux_.*mode="([a-z]+)"/m.exec(hm.replace(/\r/g, '')) || [])[1]}`);
        h.sock.close();
    } catch (e) {
        failures.push('harness: ' + e.message);
        console.error('\nharness error:', e.message);
    } finally {
        try { if (browser) await browser.disconnect(); } catch { /* ignore */ }
        if (child) await stop(child);
        if (hadPrefs && fs.existsSync(PREFS_BAK)) { fs.copyFileSync(PREFS_BAK, PREFS); console.log('\nprefs restored'); }
        if (!KEEP && !projectArg) { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ } }
    }

    if (failures.length) {
        console.error(`\n${failures.length} check(s) failed:\n   ` + failures.join('\n   '));
        process.exit(1);
    }
    console.log('\nengine output OK — the show does not depend on the UI');
    process.exit(0);
})();
