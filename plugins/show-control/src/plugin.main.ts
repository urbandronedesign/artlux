// show-control — main-process activation. Owns the embedded HTTP/SSE tablet server, the PIN/token
// auth store, the machine-global project-playlist scheduler (relaunch-per-project), and the metrics
// assembler. Talks to its renderer half over the generic plugin bridge:
//   renderer → main : configure (start/stop server), snapshot, status, engine metrics, set-lock, revoke
//   main → renderer : command (tablet/scheduler → show engine), set-schedule (tablet edited schedule)
//   handle          : lan-info, regen-pin, devices  (for the operator panel / settings)
// The playlist scheduler runs regardless of the tablet server (unattended broadcast must work even
// with the remote disabled). Everything graceful-degrades: a failed server bind logs and disables.

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as server from './server';
import * as scheduler from './scheduler';
import * as metricsSampler from './metricsSampler';
import * as auth from './auth';
import type { EngineMetrics, RenderMetrics, ShowCommand, ShowSnapshot, ShowStatus, WatchdogEventLite } from './types';

let lastEngine: EngineMetrics | null = null;
let lastRender: RenderMetrics | null = null;
let lastWatchdog: WatchdogEventLite[] = [];
let metricsTimer: ReturnType<typeof setInterval> | null = null;

export const plugin: MainPlugin = {
  manifest: { id: 'show-control', name: 'Show Control', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    const { ipc } = ctx;
    metricsSampler.start();

    // The command path the tablet + scheduler feed; forwarded to the renderer which dispatches into
    // cueBus / timeline (marker string 'showctl:command' — verify:plugins single-identity check).
    const handlers: server.ServerHandlers = {
      onCommand: (cmd: ShowCommand) => ipc.send('showctl:command', cmd),
      onPlaylistChanged: () => server.pushPlaylistStatus(scheduler.status()),
      onSchedule: (entries: unknown[]) => ipc.send('showctl:set-schedule', entries),
    };

    // Playlist scheduler: pushes current/next status to any connected tablet, and (in broadcast) does
    // the relaunch-per-project switching. Independent of the server toggle.
    scheduler.start((status) => server.pushPlaylistStatus(status));

    // Renderer starts/stops the server with the persisted { enabled, port }.
    ipc.on('showctl:configure', (cfg) => {
      const c = (cfg ?? {}) as { enabled?: boolean; port?: number };
      server.configure({ enabled: !!c.enabled, port: c.port || 8788 }, handlers);
    });

    // Live show data + status pushed up from the renderer → streamed to tablets.
    ipc.on('showctl:snapshot', (snap) => server.pushSnapshot(snap as ShowSnapshot));
    ipc.on('showctl:status', (st) => server.pushStatus(st as ShowStatus));
    ipc.on('showctl:engine-metrics', (e) => { lastEngine = (e ?? null) as EngineMetrics | null; });
    ipc.on('showctl:render-metrics', (r) => { lastRender = (r ?? null) as RenderMetrics | null; });
    ipc.on('showctl:watchdog', (w) => { lastWatchdog = (w ?? []) as WatchdogEventLite[]; });

    // Operator controls (from the app-side panel).
    ipc.on('showctl:set-lock', (v) => server.setLocked(!!v));
    ipc.on('showctl:revoke', (tok) => { auth.revoke(typeof tok === 'string' ? tok : undefined); server.disconnectRevoked(); server.pushDevices(); });

    ipc.handle('showctl:lan-info', () => server.lanInfo());
    ipc.handle('showctl:regen-pin', () => { auth.regeneratePin(); return server.lanInfo(); });
    ipc.handle('showctl:devices', () => auth.listDevices());
    ipc.handle('showctl:is-locked', () => server.isLocked());

    // Assemble + stream the metrics snapshot ~1 Hz, but only while a tablet is watching (no cost when
    // unused — the sampler is only read on demand). engine = forwarded from renderer; system = main.
    metricsTimer = setInterval(() => {
      if (!server.hasClients()) return;
      server.pushMetrics({
        engine: lastEngine,
        render: lastRender,
        system: metricsSampler.sample(),
        watchdog: lastWatchdog,
        mode: metricsSampler.appMode(),
        version: metricsSampler.appVersion(),
        ts: Date.now(),
      });
    }, 1000);
  },

  deactivate(): void {
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    server.close();
    scheduler.stop();
    metricsSampler.stop();
  },
};
