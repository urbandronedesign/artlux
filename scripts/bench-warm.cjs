// ArtLux warm-residency probe — what the preloader is ACTUALLY holding while a show runs.
//
// WHY THIS EXISTS SEPARATELY FROM bench-open.cjs. The preload budget's claim is about POOLS and
// DECODERS, and process memory is a bad instrument for it: on this fixture the renderer heap varied
// by ~900 MB run-to-run (GC timing, disk cache, what the 15 s gate happened to finish), which is
// wider than the effect being measured. A median of that proves nothing. So ask the app what it
// holds instead of inferring it from RSS — the numbers below are exact, and they are the actual
// contract: "a hub state with ten exits warms MAX_WARM pools, not ten", and "a demoted pool releases
// the path-keyed decoders its warming opened".
//
// Samples window.__artluxWarmPools() (services/timelinePreloader) once a second while the state
// machine runs, and reports the peak. Run it against a project whose FSM has a hub state — that is
// what scripts/gen-heavy-project.cjs builds by default.
//
//   npm run build
//   node scripts/bench-warm.cjs --project .traces/bench/real60/project.artlux --seconds 45

const http = require('node:http');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
// Mirrors services/timeline.GLOBAL_POOL — the shared fallback pool, which is never standby and never
// counted against the budget.
const GLOBAL_POOL = '__global__';

const PROJECT = arg('project', null);
const SECONDS = Number(arg('seconds', 45));
const PORT = Number(arg('port', 9335));
if (!PROJECT) { console.error('\n  --project <file.artlux> is required\n'); process.exit(1); }
const PROJECT_ABS = path.resolve(PROJECT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((res, rej) => {
    http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej);
});

(async () => {
    // Same spawn discipline as bench-open: the Electron binary directly, and ELECTRON_RUN_AS_NODE
    // stripped (tooling environments set it, and Electron then boots as bare Node — `app` is
    // undefined and main crashes at getVersion).
    const env = { ...process.env, ARTLUX_CDP_PORT: String(PORT) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), ['.', '--headless', `--project=${PROJECT_ABS}`],
        { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });

    const deadline = Date.now() + (SECONDS + 90) * 1000;
    let browser = null;
    try {
        let ver = null;
        while (!ver) {
            if (Date.now() > deadline) throw new Error('CDP port never opened');
            try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(500); }
        }
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });
        let page = null;
        while (!page) {
            if (Date.now() > deadline) throw new Error('editor page never appeared');
            page = (await browser.pages()).find((p) => p.url().includes('index.html'));
            if (!page) await sleep(500);
        }
        // Wait for the gate — the FSM does not tick until it arms, so sampling before that measures
        // the open, not the look-ahead.
        while (true) {
            if (Date.now() > deadline) throw new Error('gate never armed');
            const g = await page.evaluate(() => (window.__artluxBootGate ? window.__artluxBootGate() : null));
            if (g && !g.booting) break;
            await sleep(500);
        }
        console.log(`\n  armed — sampling ${SECONDS}s of show\n`);
        console.log('    t   held  pools                                        decoders  codecMB');

        let peakPools = 0, peakBytes = 0, peakDecoders = 0;
        for (let t = 0; t < SECONDS; t++) {
            const s = await page.evaluate(() => (window.__artluxWarmPools ? window.__artluxWarmPools() : null));
            if (s) {
                // `held` includes the ACTIVE pool and the GLOBAL fallback; the BUDGET governs standby.
                const standby = s.held.filter((k) => k !== s.active && k !== GLOBAL_POOL);
                peakPools = Math.max(peakPools, standby.length);
                peakBytes = Math.max(peakBytes, s.codecBytes);
                peakDecoders = Math.max(peakDecoders, s.openDecoders);
                if (t % 3 === 0) {
                    console.log(`    ${String(t).padStart(3)}  ${String(standby.length).padStart(4)}  ${standby.join(',').slice(0, 44).padEnd(44)}  ${String(s.openDecoders).padStart(8)}  ${(s.codecBytes / 1048576).toFixed(0).padStart(7)}`);
                }
            }
            await sleep(1000);
        }
        const final = await page.evaluate(() => (window.__artluxWarmPools ? window.__artluxWarmPools() : null));
        console.log(`\n  PEAK standby pools : ${peakPools}   (budget MAX_WARM = ${final?.maxWarm})`);
        console.log(`  PEAK open decoders : ${peakDecoders}`);
        console.log(`  PEAK codec bytes   : ${(peakBytes / 1048576).toFixed(0)} MB   (best-effort — see codecResidency)`);
        if (final && peakPools > final.maxWarm) {
            console.log(`\n  ⚠ THE BUDGET DID NOT BIND — ${peakPools} standby pools against a budget of ${final.maxWarm}.`);
        }
        console.log('');
    } finally {
        if (browser) try { await browser.disconnect(); } catch { /* gone */ }
        try { process.platform === 'win32' ? execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) : child.kill('SIGKILL'); } catch { /* gone */ }
        if (!log.includes('[open]')) console.error('  ⚠ app produced no [open] line — tail:\n' + log.split('\n').slice(-12).join('\n'));
    }
})().catch((e) => { console.error('\n  probe failed:', e.message, '\n'); process.exit(1); });
