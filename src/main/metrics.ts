// Prometheus metrics exposition for ARTLux.
//
// Pull model: this tiny HTTP server only does work when a collector (Prometheus,
// VictoriaMetrics, Grafana Agent, …) scrapes GET /metrics — typically every 15s.
// Between scrapes it costs nothing. There is NO push, NO extra thread, NO native
// code, and nothing runs on this machine except this responder; Prometheus +
// Grafana live on whatever machine you point at it (here: localhost for testing).
//
// Disable entirely with ARTLUX_METRICS=0. Bind elsewhere with ARTLUX_METRICS_HOST
// (default 127.0.0.1 — loopback only) / ARTLUX_METRICS_PORT (default 9464).
import { createServer, type Server } from 'node:http';
import {
    Registry,
    Gauge,
    collectDefaultMetrics,
} from 'prom-client';
import { app } from 'electron';

const register = new Registry();

// Static labels on every series so multiple ARTLux instances / modes are distinguishable.
register.setDefaultLabels({
    app: 'artlux',
    version: app.getVersion(),
    mode: process.argv.includes('--headless')
        ? 'headless'
        : process.argv.includes('--broadcast')
          ? 'broadcast'
          : 'editor',
});

// Node/process metrics (CPU, RSS/heap, event-loop lag, GC, handles). These are
// cheap — computed lazily on scrape; the only ongoing cost is a perf_hooks
// event-loop monitor, which is negligible.
collectDefaultMetrics({ register, prefix: 'artlux_' });

// ---- Engine throughput (sourced from outputManager.getStats(), already polled at 1 Hz) ----
const fps = new Gauge({
    name: 'artlux_output_fps',
    help: 'Art-Net/sACN output frames per second (native engine pacer)',
    registers: [register],
});
const pps = new Gauge({
    name: 'artlux_output_pps',
    help: 'Output packets per second across all universes',
    registers: [register],
});
const universes = new Gauge({
    name: 'artlux_output_universes',
    help: 'Number of active output universes',
    registers: [register],
});
// 1 while output is connected/ready, 0 otherwise — useful for an "is it live?" panel/alert.
const outputUp = new Gauge({
    name: 'artlux_output_up',
    help: '1 when the native output engine is ready and emitting, else 0',
    registers: [register],
});

export interface EngineStats {
    fps: number;
    pps: number;
    universes: number;
}

/** Mirror the existing 1 Hz engine stats into Prometheus gauges. Cheap; safe to call always. */
export function updateEngineStats(stats: EngineStats | null): void {
    if (!stats) {
        outputUp.set(0);
        return;
    }
    fps.set(stats.fps ?? 0);
    pps.set(stats.pps ?? 0);
    universes.set(stats.universes ?? 0);
    outputUp.set(stats.fps > 0 ? 1 : 0);
}

// ---- Renderer frame-time (pushed from the renderer's perfMonitor ~1 Hz; see shared/protocol) ----
// The renderer *frame* health is invisible to the native pacer above, and broadcast (show) mode has
// no on-screen HUD — so we surface it here for Prometheus/Grafana (and headless/broadcast baselines).
const renderFps = new Gauge({
    name: 'artlux_render_fps',
    help: 'Renderer frame loop rate (1000 / median frame interval)',
    registers: [register],
});
const renderFrameP99 = new Gauge({
    name: 'artlux_render_frame_p99_ms',
    help: 'Renderer p99 inter-frame interval in ms (the jank tail)',
    registers: [register],
});
const renderWorkP99 = new Gauge({
    name: 'artlux_render_work_p99_ms',
    help: 'Renderer p99 in-frame work time in ms (headroom indicator)',
    registers: [register],
});
const renderLongFrames = new Gauge({
    name: 'artlux_render_long_frames',
    help: 'Long (dropped) frames in the last rolling window (>1.5x median interval)',
    registers: [register],
});

export interface RenderTimingStats {
    fps: number;
    frameP99: number;
    workP99: number;
    longFrames: number;
}

/** Mirror ~1 Hz renderer frame-time stats into Prometheus gauges. Cheap; safe to call always. */
export function updateRenderStats(stats: RenderTimingStats | null): void {
    if (!stats) return;
    renderFps.set(stats.fps ?? 0);
    renderFrameP99.set(stats.frameP99 ?? 0);
    renderWorkP99.set(stats.workP99 ?? 0);
    renderLongFrames.set(stats.longFrames ?? 0);
}

let server: Server | null = null;

/** Start the /metrics HTTP endpoint. No-op if already running or disabled via env. */
export function start(): void {
    if (server) return;
    if (process.env['ARTLUX_METRICS'] === '0') {
        console.log('[metrics] disabled via ARTLUX_METRICS=0');
        return;
    }
    const host = process.env['ARTLUX_METRICS_HOST'] || '127.0.0.1';
    const port = Number(process.env['ARTLUX_METRICS_PORT']) || 9464;

    server = createServer((req, res) => {
        if (req.url === '/metrics') {
            register
                .metrics()
                .then((body) => {
                    res.writeHead(200, { 'Content-Type': register.contentType });
                    res.end(body);
                })
                .catch((err) => {
                    res.writeHead(500);
                    res.end(String(err));
                });
            return;
        }
        if (req.url === '/' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('ARTLux metrics — see /metrics\n');
            return;
        }
        res.writeHead(404);
        res.end('not found');
    });

    server.on('error', (err) => {
        console.error(`[metrics] server error (port ${port} in use?):`, err);
        server = null;
    });

    server.listen(port, host, () => {
        console.log(`[metrics] Prometheus endpoint at http://${host}:${port}/metrics`);
    });
}

/** Stop the endpoint (call on quit). */
export function stop(): void {
    server?.close();
    server = null;
}
