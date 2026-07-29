// ArtLux CPU/GPU trace capture — Chromium tracing, driven from OUTSIDE the app.
//
// WHY THIS EXISTS. The repo can already answer "did frames land on time" (services/perfMonitor) and
// "was the main thread blocked" (services/uiPerfMonitor). Neither can answer "blocked BY WHAT", because
// both measure the frame from inside it. This script asks Chromium itself, over the DevTools protocol,
// and writes a trace that ui.perfetto.dev opens directly.
//
// It changes NOTHING in the app. ARTLUX_CDP_PORT is already honoured by src/main/index.ts, and this
// attaches to a running instance — dev or packaged, editor or headless. That is the point: profiling
// must not be a build mode, or you end up measuring the instrument.
//
// WHAT YOU GET. One timeline with every Chromium thread as its own track: CrRendererMain (the one that
// runs frameEngine.tick, the timeline transport, the projector pump, the 3D scene and React, back to
// back), CrGpuMain, Compositor, and the raster pool. `devtools.timeline` names the rAF callbacks and
// marks forced synchronous layout, which is the cost WP-0.M measured but could not attribute.
//
// WHAT YOU DO NOT GET, stated plainly so nobody reads a gap as a zero:
//   • The native threads are INVISIBLE here. The Rust Art-Net pacer, the ENTTEC serial writers and the
//     JUCE audio callback are not Chromium threads and emit no trace events. Watch artlux_output_* on
//     /metrics for those — see docs/DEVELOPMENT.md.
//   • GPU *hardware* busy time is not in here either. `gpu`/`viz` show what the GPU PROCESS did, not
//     what the GPU chip did. Use Intel PresentMon beside this for the CPU-vs-GPU balance question.
//
// Usage:
//   1. Launch the app with the debugging port open (either works):
//        ARTLUX_CDP_PORT=9333 npm run dev
//        $env:ARTLUX_CDP_PORT=9333; .\release\win-unpacked\ArtLux.exe
//   2. node scripts/trace-cdp.cjs --duration 15 --label context-switch
//   3. Drag the written .json onto https://ui.perfetto.dev
//
// Flags:
//   --duration <s>   how long to record            (default 10)
//   --warmup <s>     countdown before recording    (default 3 — time to get your hand on the mouse)
//   --label <name>   goes in the filename          (default "trace")
//   --out <dir>      output directory              (default .traces/)
//   --port <n>       CDP port                      (default $ARTLUX_CDP_PORT or 9333)
//   --js             add the V8 sampling profiler  (JS flame chart; heavier trace)
//   --heavy          add task-queue + V8 execute detail (much heavier; use for a short capture)
//   --categories a,b replace the category set outright
//
// ⚠ ARTLUX_CDP_PORT FORCES A PAINT. That is harmless for profiling and fatal for anything else: a run
// with this port set can never be used to verify that a window becomes visible. See CLAUDE.md.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DURATION_S = Number(arg('duration', 10));
const WARMUP_S = Number(arg('warmup', 3));
const LABEL = arg('label', 'trace').replace(/[^a-z0-9._-]+/gi, '-');
const OUT_DIR = path.resolve(ROOT, arg('out', '.traces'));
const CDP_PORT = arg('port', process.env.ARTLUX_CDP_PORT || '9333');

// The default set. Chosen to answer THIS app's question — which of the five rAF loops on the renderer
// main thread owns the frame — without producing a trace so large the UI struggles to open it.
//
// `devtools.timeline` is the load-bearing one: it emits FireAnimationFrame, FunctionCall, Layout and
// the forced-reflow markers, which is how you attribute a stall rather than merely observe it.
// `blink.user_timing` carries performance.mark/measure, so any marks added to the frame engine later
// land on the same timeline for free.
const BASE_CATEGORIES = [
    'toplevel',                                  // one slice per task on every thread — the queue itself
    'devtools.timeline',                         // rAF callbacks, layout, paint, forced reflow
    'disabled-by-default-devtools.timeline',     // the detail behind those
    'disabled-by-default-devtools.timeline.frame',
    'blink.user_timing',                         // performance.mark / measure
    'gpu',                                       // GPU process work
    'viz',                                       // display compositor
    'latency',
];
// JS flame chart. Separate because the sampler adds real overhead to the thread being measured.
const JS_CATEGORIES = ['disabled-by-default-v8.cpu_profiler'];
// Compositor internals, task-queue and JS-execution detail. `cc` was in the default set until it was
// measured: 8 s of an idle editor went 86.3 MB without it and 99.8 MB with, for detail that does not
// answer the question this script is usually taken for — which rAF callback owns the frame. The other
// three are far heavier again. Keep such captures short.
const HEAVY_CATEGORIES = ['cc', 'sequence_manager', 'v8', 'v8.execute'];

const categories = arg('categories', null)
    ? arg('categories', '').split(',').map((s) => s.trim()).filter(Boolean)
    : [...BASE_CATEGORIES, ...(has('js') ? JS_CATEGORIES : []), ...(has('heavy') ? HEAVY_CATEGORIES : [])];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// CDP discovery — the same door scripts/capture-docs.cjs uses
// ---------------------------------------------------------------------------
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function findApp() {
    try {
        return await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
    } catch {
        console.error(`\n  No ArtLux is listening on CDP port ${CDP_PORT}.`);
        console.error('  Start one first, for example:');
        console.error(`      $env:ARTLUX_CDP_PORT=${CDP_PORT}; npm run dev`);
        console.error(`      $env:ARTLUX_CDP_PORT=${CDP_PORT}; .\\release\\win-unpacked\\ArtLux.exe`);
        console.error('  …then run this again.\n');
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Trace summary — an instrument that cannot report its own silence is worthless
// ---------------------------------------------------------------------------
/**
 * Name the threads the capture actually contains, and how many events landed on each.
 *
 * This is not decoration. The repo's own profiling history is a list of confident zeroes: a profiler
 * that was off reported 0 and 0 read exactly like "free"; a second module instance reported zero
 * forever; a longtask gauge reported 101 ms for a 900 ms freeze. So this script REFUSES to write a
 * silent trace, and prints what it saw so you can check the thread you care about is in there before
 * you spend twenty minutes reading it.
 */
function summarize(events) {
    const threads = new Map();  // "pid/tid" -> { name, process, count }
    const key = (e) => `${e.pid}/${e.tid}`;

    for (const e of events) {
        if (e.ph !== 'M') continue;
        if (e.name === 'thread_name') {
            const t = threads.get(key(e)) || { name: '', process: '', count: 0 };
            t.name = e.args?.name || '';
            threads.set(key(e), t);
        } else if (e.name === 'process_name') {
            for (const [k, t] of threads) {
                if (k.startsWith(`${e.pid}/`)) t.process = e.args?.name || '';
            }
        }
    }
    for (const e of events) {
        if (e.ph === 'M') continue;
        const t = threads.get(key(e));
        if (t) t.count++;
    }
    return [...threads.values()].filter((t) => t.count > 0).sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------------------
(async () => {
    const ver = await findApp();
    console.log(`\n  attached to ${ver.Browser || 'Electron'} on port ${CDP_PORT}`);
    console.log(`  categories (${categories.length}): ${categories.join(', ')}\n`);

    const browser = await puppeteer.connect({
        browserWSEndpoint: ver.webSocketDebuggerUrl,
        defaultViewport: null,
    });

    // Tracing is a BROWSER-level domain — a session on the browser target captures every process
    // (renderer, GPU, utility), which is the entire reason to use this rather than the Performance
    // panel on one page.
    const session = await browser.target().createCDPSession();

    const events = [];
    session.on('Tracing.dataCollected', ({ value }) => {
        // push in a loop, not spread: a busy 15 s capture is hundreds of thousands of events and
        // `push(...value)` would exceed the argument limit and throw.
        for (let i = 0; i < value.length; i++) events.push(value[i]);
    });
    let bufferFull = false;
    session.on('Tracing.bufferUsage', ({ percentFull }) => {
        if (percentFull !== undefined && percentFull > 0.9 && !bufferFull) {
            bufferFull = true;
            console.warn('  ⚠ trace buffer over 90% — the tail of this capture may be dropped.');
            console.warn('    Shorten --duration, or drop --heavy/--js.');
        }
    });

    for (let s = WARMUP_S; s > 0; s--) {
        process.stdout.write(`\r  recording in ${s}…   `);
        await sleep(1000);
    }

    await session.send('Tracing.start', {
        traceConfig: {
            // As much as the buffer will hold, rather than stopping at the first overflow — a capture
            // that quietly ends early looks identical to an app that quietly went idle.
            recordMode: 'recordAsMuchAsPossible',
            includedCategories: categories,
        },
        transferMode: 'ReportEvents',
        bufferUsageReportingInterval: 1000,
    });

    const t0 = Date.now();
    for (let s = DURATION_S; s > 0; s--) {
        process.stdout.write(`\r  ● RECORDING — ${s}s left. Exercise the app now.        `);
        await sleep(1000);
    }
    const recorded = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write('\r  draining the buffer…                                  \n');

    // The drain is NOT part of the recording and is reported separately. It is slow — half a million
    // events cross the websocket one `Tracing.dataCollected` batch at a time, and an 8 s capture took
    // ~10 s to hand over. Folding the two together would overstate the window the trace covers, which
    // is the sort of quiet arithmetic error that makes a measurement useless later.
    const drainStart = Date.now();
    const complete = new Promise((resolve) => session.once('Tracing.tracingComplete', resolve));
    await session.send('Tracing.end');
    await complete;
    const drained = ((Date.now() - drainStart) / 1000).toFixed(1);

    await browser.disconnect();

    // ---- Refuse to write a silent trace --------------------------------------------------------
    if (events.length === 0) {
        console.error('\n  CAPTURED NOTHING — 0 trace events.');
        console.error('  This is a failed capture, not an idle app. Likely causes:');
        console.error('    • another tracing session was already running (only one at a time is allowed)');
        console.error('    • every category was rejected — check --categories spelling');
        console.error('  Nothing was written.\n');
        process.exit(1);
    }

    const threads = summarize(events);
    const renderer = threads.find((t) => t.name === 'CrRendererMain');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(OUT_DIR, `${LABEL}-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify({
        traceEvents: events,
        metadata: {
            'artlux-label': LABEL,
            'artlux-categories': categories.join(','),
            'artlux-recorded-s': recorded,
            'artlux-captured': new Date().toISOString(),
        },
    }));

    const mb = (fs.statSync(file).size / 1048576).toFixed(1);
    console.log(`\n  ${events.length.toLocaleString()} events over ${recorded}s of recording → ${mb} MB (drained in ${drained}s)`);
    console.log(`  ${path.relative(ROOT, file)}\n`);

    console.log('  threads captured (events, busiest first):');
    for (const t of threads.slice(0, 12)) {
        const nm = (t.name || '(unnamed)').padEnd(22);
        console.log(`    ${nm} ${String(t.count).padStart(8)}  ${t.process}`);
    }
    if (threads.length > 12) console.log(`    …and ${threads.length - 12} more`);

    // The one thread this whole exercise is about. If it is missing, the trace cannot answer the
    // question that motivated it, and saying so now is cheaper than discovering it in the UI.
    if (!renderer) {
        console.warn('\n  ⚠ NO CrRendererMain IN THIS TRACE.');
        console.warn('    That is the thread that runs the frame engine, the timeline, the projector');
        console.warn('    pump, the 3D scene and React. Without it this capture cannot answer the');
        console.warn('    question it was taken for. Is the editor window actually open?');
    }

    console.log('\n  open it:  https://ui.perfetto.dev   (drag the file in — it stays on your machine)');
    console.log('  look for: CrRendererMain → the FireAnimationFrame slices, back to back.');
    console.log('            Anything marked "Forced reflow" is a synchronous layout.\n');
    console.log('  GPU hardware busy time is NOT in this trace — run Intel PresentMon alongside it.\n');
})().catch((e) => {
    console.error('\n  trace capture failed:', e && e.message ? e.message : e, '\n');
    process.exit(1);
});
