// show-control — renderer activation (main window drives; contributions register in every window).
//
//   • Settings section + operator panel contributions (Preferences + View ▸ Show Control).
//   • Command intake: main forwards tablet/scheduler commands here → dispatch into cueBus/timeline.
//   • Snapshot/status/engine-metrics push UP to main → streamed to tablets over SSE.
//   • In-project wall-clock schedule tick (renderer-side; this app disables renderer timer throttling,
//     so it runs in broadcast too). Fires a ShowCommand at HH:MM on selected weekdays.
//   • Server (re)configure from the plugin's persisted { enabled, port }.

import type { RendererPlugin, RendererPluginContext, RendererHostServices } from '@artlux/sdk/renderer';
import { setHost } from './showControlHost';
import { dispatch } from './dispatch';
import { ShowControlSettings } from './ShowControlSettings';
import { ShowControlPanel } from './ShowControlPanel';
import { ShowControlDeck } from './ShowControlDeck';
import { SchedulePanel } from './SchedulePanel';
import { PlaylistPanel } from './PlaylistPanel';
import { ShowMetricsPanel } from './ShowMetricsPanel';
import type { ShowCommand, ShowSnapshot, ShowStatus, ScheduleEntry } from './types';

let timers: ReturnType<typeof setInterval>[] = [];
let unsubs: (() => void)[] = [];

function pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }

// Map the host show model (structural — no host-type import) to the lightweight tablet snapshot.
function buildSnapshot(host: RendererHostServices): ShowSnapshot {
  const sm = host.show.getStateMachine() as any;
  const scenes = (host.show.getScenes() as any[]) || [];
  const banks = (host.show.getCueBanks() as any[]) || [];
  const schedule = (host.show.getSchedule() as ScheduleEntry[]) || [];
  return {
    scenes: scenes.map((s) => ({ id: s.id, name: s.name, accent: s.accent })),
    banks: banks.map((b) => ({
      id: b.id, name: b.name, rows: b.rows, cols: b.cols,
      cues: (b.cues || []).map((c: any) => ({ id: c.id, name: c.name, row: c.row, col: c.col, color: c.color })),
      sceneCells: (b.sceneCells || []).map((sc: any) => ({ col: sc.col, sceneId: sc.sceneId })),
    })),
    fsm: {
      enabled: !!(sm && sm.enabled),
      initialStateId: (sm && sm.initialStateId) ?? null,
      states: ((sm && sm.states) || []).map((st: any) => ({ id: st.id, name: st.name, sceneId: st.sceneId })),
      transitions: ((sm && sm.transitions) || []).map((t: any) => ({ id: t.id, from: t.from, to: t.to, manual: !!(t.trigger && t.trigger.kind === 'manual') })),
    },
    schedule,
    projectName: '',
  };
}

export const plugin: RendererPlugin = {
  manifest: { id: 'show-control', name: 'Show Control', version: '0.0.0' },

  activate(ctx: RendererPluginContext): void {
    const host = ctx.host as RendererHostServices;
    setHost(host, ctx.ipc);

    // Contributions (Preferences section + operator modal). Marker strings guarded by verify:plugins.
    ctx.settings.register({ id: 'show-control', title: 'Show Control', Component: ShowControlSettings });
    // A DOCK tab on the host's `show` context: the connect URL/QR/PIN and the paired-device list are
    // things an operator keeps visible while running a show, not a dialog to dismiss.
    ctx.panels.register({ id: 'show-control', mount: 'dock', menuAction: 'show-control', title: 'Show Control', Component: ShowControlPanel });

    // The REMOTE's own tabs, on the desktop. Control · States · Schedule · Projects · Metrics all
    // existed only inside the served tablet PWA, so an operator at the machine could arm an unattended
    // venue from a phone but not from the app in front of them. These are the same data and the same
    // command path (host.show / the plugin bridge) — one model, two surfaces.
    ctx.panels.register({ id: 'show-control.deck', mount: 'viewport', title: 'Show Deck', Component: ShowControlDeck });
    ctx.panels.register({ id: 'show-control.schedule', mount: 'dock', title: 'Schedule', Component: SchedulePanel });
    ctx.panels.register({ id: 'show-control.playlist', mount: 'dock', title: 'Playlist', Component: PlaylistPanel });
    ctx.panels.register({ id: 'show-control.metrics', mount: 'dock', title: 'Metrics', Component: ShowMetricsPanel });
    ctx.contexts.extend('show', {
      viewport: 'show-control.deck',
      dock: ['show-control.schedule', 'show-control.playlist', 'show-control.metrics', 'show-control'],
    });

    // Only the main editor/broadcast window owns the show engine + the bridge to main.
    if (ctx.window !== 'main') return;

    // Tablet/scheduler commands (main → here) → the show engine.
    unsubs.push(ctx.ipc.on('showctl:command', (cmd) => { try { dispatch(host, cmd as ShowCommand); } catch (e) { console.error('[show-control] dispatch failed', e); } }));
    // Tablet edited the in-project schedule → write back through App state (persists in ProjectData).
    unsubs.push(ctx.ipc.on('showctl:set-schedule', (entries) => host.show.setSchedule((entries as unknown[]) ?? [])));

    // Push the show snapshot up whenever scenes/cues/FSM/schedule change (+ once now).
    //
    // AND ON A HEARTBEAT, because this is the ONE payload that is not periodic. Status (2 Hz) and
    // metrics (1 Hz) stream forever and repair themselves; the scene/cue/FSM list is sent once at
    // activation — when the project is still EMPTY — and then only when host.show fans out a change.
    // So a single push that is missed, or that lands before the project has loaded with nothing
    // changing afterwards (an unattended venue changes nothing), leaves the tablet reading "No scenes
    // in this project" for the life of the show. Nothing on the desktop reveals it either: the Show
    // Deck re-reads host.show when it MOUNTS, so the operator's own screen is right while the phone
    // is wrong — which is exactly how this was found, in a venue, on a machine whose deck listed
    // every scene.
    //
    // Re-send only when the payload actually CHANGED: an unconditional re-push would re-render the
    // tablet's Control tab every couple of seconds for nothing (renderIfDynamic repaints on any
    // snapshot). `force` skips the compare — used when main asks, because then it is main's copy
    // that is suspect, not ours.
    let lastSnapJson = '';
    const pushSnapshot = (force = false) => {
      const snap = buildSnapshot(host);
      const json = JSON.stringify(snap);
      if (!force && json === lastSnapJson) return;
      lastSnapJson = json;
      ctx.ipc.send('showctl:snapshot', snap);
    };
    unsubs.push(host.show.subscribe(() => pushSnapshot()));
    // A tablet just connected and main replayed whatever it last cached. Re-send unconditionally so a
    // stale or absent cache cannot outlive the connection that exposes it.
    unsubs.push(ctx.ipc.on('showctl:request-snapshot', () => pushSnapshot(true)));
    pushSnapshot(true);

    // (Re)configure the tablet server from the plugin's persisted { enabled, port } (+ once now).
    const pushConfig = () => {
      const s = host.settings.get() as { plugins?: Record<string, unknown> };
      const cfg = (s.plugins?.['show-control'] as { enabled?: boolean; port?: number }) ?? {};
      ctx.ipc.send('showctl:configure', { enabled: cfg.enabled ?? true, port: cfg.port ?? 8788 });
    };
    unsubs.push(host.settings.subscribe(pushConfig));
    pushConfig();

    // Live status → main (~2 Hz). Cheap; SSE fans it out to tablets. Every 4th tick also re-offers the
    // snapshot (the heartbeat above) — one timer, not two, and a no-op on the ticks where nothing moved.
    let tick = 0;
    timers.push(setInterval(() => {
      const st = host.show.getStatus();
      const status: ShowStatus = { ...st, ts: Date.now() };
      ctx.ipc.send('showctl:status', status);
      if (++tick % 4 === 0) pushSnapshot();
    }, 500));

    // Forward native engine throughput (public onDmxStats ~1 Hz) → main assembles the metrics snapshot.
    const offStats = window.artlux?.onDmxStats?.((s: { fps?: number; pps?: number; universes?: number }) => {
      const fps = s.fps ?? 0;
      ctx.ipc.send('showctl:engine-metrics', { fps, pps: s.pps ?? 0, universes: s.universes ?? 0, up: fps > 0 });
    });
    if (offStats) unsubs.push(offStats);

    // Forward renderer frame-time (perfMonitor via the host context, ~1 Hz) → the metrics snapshot.
    unsubs.push(ctx.onRenderStats((r) => ctx.ipc.send('showctl:render-metrics', r)));

    // Forward unattended-watchdog self-heal events (core main, via the public API) → main → the tablet
    // Metrics tab, so an operator can see WHY the show restarted overnight. Seed from the persistent
    // log tail (survives relaunches), then append live events.
    let wdRecent: { ts: number; trigger: string; action: string; detail: string; outcome: string }[] = [];
    const mapWd = (e: any) => ({ ts: e.ts, trigger: e.trigger, action: e.action, detail: e.detail, outcome: e.outcome });
    const pushWatchdog = () => ctx.ipc.send('showctl:watchdog', wdRecent);
    window.artlux?.getWatchdogStatus?.().then((st: any) => { wdRecent = (st?.recent ?? []).slice(0, 20).map(mapWd); pushWatchdog(); }).catch(() => {});
    const offWd = window.artlux?.onWatchdogEvent?.((e: any) => { wdRecent = [mapWd(e), ...wdRecent].slice(0, 20); pushWatchdog(); });
    if (offWd) unsubs.push(offWd);

    // In-project schedule tick. Evaluated every 15s; fires each entry once per matching minute.
    const lastFired = new Map<string, string>();
    timers.push(setInterval(() => {
      const entries = (host.show.getSchedule() as ScheduleEntry[]) || [];
      if (!entries.length) return;
      const now = new Date();
      const hm = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
      const day = now.getDay();
      const key = day + '-' + hm;
      for (const e of entries) {
        if (!e || !e.enabled || e.time !== hm) continue;
        if (e.days && e.days.length && e.days.indexOf(day) < 0) continue;
        if (lastFired.get(e.id) === key) continue;
        lastFired.set(e.id, key);
        try { dispatch(host, e.action); } catch (err) { console.error('[show-control] schedule dispatch failed', err); }
      }
    }, 15000));
  },

  deactivate(): void {
    timers.forEach(clearInterval); timers = [];
    unsubs.forEach((u) => { try { u(); } catch { /* */ } }); unsubs = [];
  },
};
