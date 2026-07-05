// Main-process system metrics — the same quantities prom-client's collectDefaultMetrics computes for
// the /metrics endpoint (CPU %, RSS, heap, event-loop lag), sampled directly so the tablet gets them
// as structured JSON without scraping the Prometheus text or exposing that endpoint on the network.
// Engine throughput (fps/pps/universes) is forwarded from the renderer (public onDmxStats) — see
// plugin.main. Renderer frame-time (perfMonitor) is intentionally out of scope for v1 (no host seam).

import { app } from 'electron';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { SystemMetrics } from './types';

const NS_PER_MS = 1e6;

let hist: ReturnType<typeof monitorEventLoopDelay> | null = null;
let lastCpu: NodeJS.CpuUsage | null = null;
let lastAt = 0;

export function start(): void {
  if (hist) return;
  hist = monitorEventLoopDelay({ resolution: 10 });
  hist.enable();
  lastCpu = process.cpuUsage();
  lastAt = Date.now();
}

export function stop(): void {
  hist?.disable();
  hist = null;
  lastCpu = null;
}

const mode = process.argv.includes('--headless') ? 'headless'
  : process.argv.includes('--broadcast') ? 'broadcast'
  : 'editor';

export function sample(): SystemMetrics {
  const now = Date.now();
  const cpu = process.cpuUsage();
  let cpuPct = 0;
  if (lastCpu && now > lastAt) {
    const usedMicros = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
    cpuPct = (usedMicros / 1000) / (now - lastAt) * 100; // micros→ms over elapsed ms
  }
  lastCpu = cpu;
  lastAt = now;

  const mem = process.memoryUsage();
  const p50 = hist ? hist.percentile(50) / NS_PER_MS : 0;
  const p99 = hist ? hist.percentile(99) / NS_PER_MS : 0;
  hist?.reset();

  return {
    cpuPct: Math.max(0, Math.round(cpuPct * 10) / 10),
    rssMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    eventLoopLagP50Ms: Math.round(p50 * 100) / 100,
    eventLoopLagP99Ms: Math.round(p99 * 100) / 100,
  };
}

export function appVersion(): string { return app.getVersion(); }
export function appMode(): string { return mode; }
