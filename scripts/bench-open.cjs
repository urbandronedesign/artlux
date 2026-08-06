// ArtLux cold-open bench — the scoreboard for plans/preload-optimization.md. Opens a project headless, waits for the
// boot gate to arm, and reports the four metrics every optimization phase is judged against:
//
//   A  time-to-arm            renderer open-trace, 'begin' → 'gate-armed'   (services/openTrace.ts)
//   B  …as a fn of scene count  run this over gen-heavy-project's --scenes sweep and compare
//   C  memory                 main RSS at parse + peak main RSS (win32) + renderer JS heap at arm
//   D  bytes read vs shown    main's READ_FILE counter ([ipc] read-file totals, reset per open)
//
// ⚠ RUN THE BUILT APP, NEVER THE DEV SERVER. `npm run build` first. Under electron-vite dev, vite's
//   module serving + HMR cost lands inside every phase and is measured as ours.
// ⚠ ARTLUX_CDP_PORT FORCES A PAINT (CLAUDE.md) — fine for timing, disqualifying for window-visibility
//   claims. This bench makes none.
// ⚠ Headless suppresses the splash + projector windows: the splash dwell problem is NOT measured here
//   (packaged launch, no CDP port, by eye — see the plan, phase 7).
//
// Usage:
//   node scripts/gen-heavy-project.cjs --out .traces/bench/heavy --scenes 60
//   npm run build
//   node scripts/bench-open.cjs --project .traces/bench/heavy/project.artlux --runs 3
//   node scripts/bench-open.cjs --project ... --baseline .traces/bench/open-heavy-<stamp>.json
//
// Flags:
//   --project <file>   the .artlux to open (required)
//   --runs <n>         spawn/measure/kill cycles (default 3; medians reported)
//   --baseline <json>  a previous run's output — prints signed deltas
//   --port <n>         CDP port (default 9334 — distinct from trace-cdp's 9333 so both can coexist)
//   --timeout <s>      per-run give-up (default 120)
//   --label <name>     output filename tag (default the project folder's name)

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PROJECT = arg('project', null);
const RUNS = Number(arg('runs', 3));
const BASELINE = arg('baseline', null);
const PORT = Number(arg('port', 9334));
const TIMEOUT_S = Number(arg('timeout', 120));

if (!PROJECT || !fs.existsSync(PROJECT)) {
    console.error('\n  --project <file.artlux> is required (and must exist).');
    console.error('  Generate one:  node scripts/gen-heavy-project.cjs --out .traces/bench/heavy --scenes 60\n');
    process.exit(1);
}
const PROJECT_ABS = path.resolve(PROJECT);
const LABEL = String(arg('label', path.basename(path.dirname(PROJECT_ABS)))).replace(/[^a-z0-9._-]+/gi, '-');

if (!fs.existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
    console.error('\n  out/main/index.js is missing — run `npm run build` first.');
    console.error('  (The bench must measure the built app; the dev server would be measured as the app.)\n');
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (url) => new Promise((resolve, reject) => {
    http.get(url, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
});

// Peak main-process RSS, win32 only (tasklist poll). Renderer memory is read over CDP instead —
// summing every Electron child would attribute the GPU process's noise to us.
function sampleMainRss(pid) {
    if (process.platform !== 'win32') return null;
    try {
        const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: 'utf8' });
        // Last CSV field is the memory column. LOCALE-PROOF parsing: "48,108 K" on an English Windows,
        // "48 108 Ko" (non-breaking spaces) on a French one — take the digits, assume KB. A literal
        // " K" suffix match silently returns null on every non-English machine.
        const fields = out.trim().split(String.fromCharCode(34)+','+String.fromCharCode(34));
        const kb = parseInt(String(fields[fields.length - 1]).replace(/[^0-9]/g, ''), 10);
        return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null; // MB
    } catch { return null; }
}

// ---------------------------------------------------------------------------
async function benchOnce(runIdx) {
    // Fresh stdout capture per run — main's [open] and [ipc] read-file lines are half the metrics.
    let mainLog = '';
    // Under plain node, require('electron') returns the path to the Electron binary — spawn that
    // directly (no npx, no shell). And STRIP ELECTRON_RUN_AS_NODE: tooling environments (Claude Code,
    // VS Code tasks) set it for their own children, it inherits through process.env, and Electron then
    // boots as bare Node — `app` is undefined and main crashes at getVersion. Cost one bench run to find.
    const env = { ...process.env, ARTLUX_CDP_PORT: String(PORT) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
        require('electron'),
        ['.', '--headless', `--project=${PROJECT_ABS}`],
        { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child.stdout.on('data', (d) => { mainLog += d.toString(); });
    child.stderr.on('data', (d) => { mainLog += d.toString(); });

    let peakRssMB = 0;
    const rssTimer = setInterval(() => {
        const rss = sampleMainRss(child.pid);
        if (rss && rss > peakRssMB) peakRssMB = rss;
    }, 500);

    const deadline = Date.now() + TIMEOUT_S * 1000;
    let browser = null;
    try {
        // Attach — the app needs a few seconds to open the port.
        let ver = null;
        while (!ver) {
            if (Date.now() > deadline) throw new Error('CDP port never opened — did the app crash? see the log below');
            try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await sleep(500); }
        }
        browser = await puppeteer.connect({ browserWSEndpoint: ver.webSocketDebuggerUrl, defaultViewport: null });

        // The editor page (headless boots index.html?headless=1 — same entry, see CLAUDE.md).
        let page = null;
        while (!page) {
            if (Date.now() > deadline) throw new Error('editor page never appeared');
            page = (await browser.pages()).find((p) => p.url().includes('index.html'));
            if (!page) await sleep(500);
        }

        // Wait for the gate by POLLING the open-trace, not by racing the console: the page can attach
        // after `[boot] armed …` has already been printed, and a missed line would hang the bench.
        let marks = null;
        while (true) {
            if (Date.now() > deadline) throw new Error(`gate never armed within ${TIMEOUT_S}s`);
            marks = await page.evaluate(() => (window.__artluxOpenTrace ? window.__artluxOpenTrace() : []));
            if (marks.some((m) => m.phase === 'gate-armed')) break;
            await sleep(500);
        }
        // One settle beat: PERF_OPEN_ARMED crosses to main and prints the read-file totals line.
        await sleep(1000);

        const heapMB = await page.evaluate(() =>
            (performance).memory ? (performance).memory.usedJSHeapSize / 1048576 : null);
        // WHY the gate released — 'ready' | 'timeout' | 'manual'. Read from the gate itself: its
        // console line lands in the renderer console, which never reaches main's stdout.
        const gate = await page.evaluate(() => (window.__artluxBootGate ? window.__artluxBootGate() : null));

        // Main-side lines. [open] read=12ms parse=340ms resolve=8ms bytes=... scenes=60 clips=720 rssMB=210
        const open = /\[open\] read=(\d+)ms parse=(\d+)ms resolve=(\d+)ms bytes=(\d+) scenes=(\d+) clips=(\d+) rssMB=(\d+)/.exec(mainLog);
        const rf = /\[ipc\] read-file totals since last open: (\d+) call\(s\), ([\d.]+) MB, (\d+) ms, largest ([\d.]+) MB/.exec(mainLog);

        const gateArmed = marks.find((m) => m.phase === 'gate-armed');
        const gateHeld = marks.find((m) => m.phase === 'gate-held');
        return {
            run: runIdx,
            timeToArmMs: gateArmed ? gateArmed.at : null,             // metric A (renderer-side span)
            gateHoldMs: gateArmed && gateHeld ? Math.round((gateArmed.at - gateHeld.at) * 10) / 10 : null,
            marks,
            mainOpen: open ? { readMs: +open[1], parseMs: +open[2], resolveMs: +open[3], bytes: +open[4], scenes: +open[5], clips: +open[6], rssMB: +open[7] } : null,
            readFile: rf ? { calls: +rf[1], mb: +rf[2], ms: +rf[3], largestMb: +rf[4] } : null,  // metric D
            armedBy: gate?.armedBy ?? 'unknown',
            rendererHeapMB: heapMB ? Math.round(heapMB) : null,       // metric C (renderer)
            peakMainRssMB: peakRssMB ? Math.round(peakRssMB) : null,  // metric C (main, win32 poll)
        };
    } finally {
        clearInterval(rssTimer);
        if (browser) try { await browser.disconnect(); } catch { /* already gone */ }
        try { process.platform === 'win32' ? execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }) : child.kill('SIGKILL'); } catch { /* already dead */ }
        await sleep(1500); // let the port free before the next run
        // Surface a crashed run's log — a bench that swallows the crash reports garbage as data.
        if (!mainLog.includes('[open]')) {
            console.error('  ⚠ no [open] line in main output — tail of the log:');
            console.error(mainLog.split('\n').slice(-15).map((l) => '    ' + l).join('\n'));
        }
    }
}

const median = (xs) => {
    const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
};

// ---------------------------------------------------------------------------
(async () => {
    console.log(`\nbench-open · ${path.relative(ROOT, PROJECT_ABS)} · ${RUNS} run(s) · CDP ${PORT}\n`);
    const runs = [];
    for (let i = 1; i <= RUNS; i++) {
        process.stdout.write(`  run ${i}/${RUNS}… `);
        try {
            const r = await benchOnce(i);
            runs.push(r);
            console.log(`arm ${r.timeToArmMs}ms (hold ${r.gateHoldMs}ms, ${r.armedBy}) · parse ${r.mainOpen?.parseMs ?? '?'}ms · read-file ${r.readFile ? r.readFile.mb + ' MB/' + r.readFile.calls : '?'} · heap ${r.rendererHeapMB ?? '?'} MB · peak RSS ${r.peakMainRssMB ?? '?'} MB`);
        } catch (e) {
            console.log(`FAILED — ${e.message}`);
        }
    }
    if (!runs.length) { console.error('\n  every run failed — nothing written.\n'); process.exit(1); }

    const agg = {
        project: path.relative(ROOT, PROJECT_ABS),
        label: LABEL,
        captured: new Date().toISOString(),
        runs,
        median: {
            timeToArmMs: median(runs.map((r) => r.timeToArmMs)),
            gateHoldMs: median(runs.map((r) => r.gateHoldMs)),
            parseMs: median(runs.map((r) => r.mainOpen?.parseMs)),
            readMs: median(runs.map((r) => r.mainOpen?.readMs)),
            resolveMs: median(runs.map((r) => r.mainOpen?.resolveMs)),
            readFileMb: median(runs.map((r) => r.readFile?.mb)),
            readFileCalls: median(runs.map((r) => r.readFile?.calls)),
            rendererHeapMB: median(runs.map((r) => r.rendererHeapMB)),
            peakMainRssMB: median(runs.map((r) => r.peakMainRssMB)),
        },
        scenes: runs[0].mainOpen?.scenes ?? null,
        clips: runs[0].mainOpen?.clips ?? null,
    };

    const outDir = path.join(ROOT, '.traces', 'bench');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outFile = path.join(outDir, `open-${LABEL}-${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(agg, null, 2));

    console.log(`\n  medians over ${runs.length} run(s)  (scenes=${agg.scenes}, clips=${agg.clips}):`);
    const row = (k, unit) => console.log(`    ${k.padEnd(16)} ${agg.median[k] === null ? 'n/a' : agg.median[k] + unit}`);
    row('timeToArmMs', ' ms'); row('gateHoldMs', ' ms'); row('readMs', ' ms'); row('parseMs', ' ms'); row('resolveMs', ' ms');
    row('readFileMb', ' MB'); row('readFileCalls', ''); row('rendererHeapMB', ' MB'); row('peakMainRssMB', ' MB');

    if (BASELINE) {
        try {
            const base = JSON.parse(fs.readFileSync(path.resolve(BASELINE), 'utf8'));
            console.log(`\n  Δ vs baseline (${path.basename(BASELINE)}):`);
            for (const k of Object.keys(agg.median)) {
                const a = agg.median[k], b = base.median?.[k];
                if (a === null || b === null || b === undefined) continue;
                const d = a - b;
                const pct = b !== 0 ? ` (${d >= 0 ? '+' : ''}${((d / b) * 100).toFixed(0)}%)` : '';
                console.log(`    ${k.padEnd(16)} ${d >= 0 ? '+' : ''}${Math.round(d * 10) / 10}${pct}`);
            }
        } catch (e) { console.error(`  baseline unreadable: ${e.message}`); }
    }
    console.log(`\n  ${path.relative(ROOT, outFile)}\n`);
})().catch((e) => { console.error('\n  bench failed:', e.message, '\n'); process.exit(1); });
