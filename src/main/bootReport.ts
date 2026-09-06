// THE BOOT REPORT — what loaded, what didn't, and how long it took.
//
// Every native-backed feature in ArtLux graceful-degrades on purpose: a missing `.node` disables the
// feature, logs one line, and the app boots looking perfectly healthy (see the module-load logs in
// outputManager / nvwarpManager / each plugin's manager). That is the right behaviour for a live show
// and a terrible one for a human — on a load-in nobody is watching a terminal, so "why is there no
// NDI on this machine" costs real minutes to answer.
//
// So the results are collected here as data instead of only as console lines, and the startup splash
// renders them (main/splashWindow.ts). Two waves report: the host's own natives + the main-process
// plugin halves (during registerIpc, before any window exists), then the editor renderer's plugin
// halves once App mounts. The splash may attach at any point in between, so this module keeps the
// whole report and re-sends ALL of it on every change — the receiver renders a snapshot and never has
// to reassemble a stream it joined late.
//
// It is deliberately inert unless something subscribes: in headless/broadcast no splash exists, the
// entries pile up in an array of ~16 small objects, and nothing else happens.

import type { BootEntry, BootReport } from '../../shared/protocol';
import * as output from './transport/outputManager';
import * as nvwarp from './nvwarpManager';
import * as logger from './logger';

const entries: BootEntry[] = [];
let mainDone = false;
let rendererDone = false;
const subs = new Set<(r: BootReport) => void>();

const snapshot = (): BootReport => ({ entries: entries.slice(), mainDone, rendererDone });

const notify = (): void => { const r = snapshot(); subs.forEach((cb) => cb(r)); };

export function record(entry: BootEntry): void {
  entries.push(entry);
  // Also as a durable record. `ms` is the load duration this module already measures, and the state is
  // what turns "why is there no NDI on this machine" from a load-in question into a grep.
  logger.log(entry.state === 'ok' ? 'info' : 'warn', 'boot', 'boot.module', {
    id: entry.id, group: entry.group, state: entry.state, ms: entry.ms ?? null, detail: entry.detail ?? null,
  });
  notify();
}

/**
 * Replace a group wholesale. The renderer can report twice — a dev hot-reload re-runs activation —
 * and appending would grow a duplicate list every time. Keyed by group because that is exactly the
 * unit one process reports.
 */
export function recordGroup(group: BootEntry['group'], next: BootEntry[]): void {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]!.group === group) entries.splice(i, 1);
  entries.push(...next);
  notify();
}

/** The host's own native addons — the ones no plugin owns. Both fall back rather than failing. */
export function recordHostNatives(): void {
  record({
    group: 'native', id: 'output-engine', name: 'output-engine',
    ...(output.isLoaded()
      ? { state: 'ok' as const, detail: 'Art-Net / sACN send thread' }
      : { state: 'degraded' as const, detail: 'addon missing — TypeScript transport' }),
  });
  // Three outcomes, and the middle one is the common one on a laptop: the addon is a committed
  // prebuilt that loads anywhere, but NVAPI only answers on a Quadro/RTX-pro GPU.
  record({
    group: 'native', id: 'nvwarp', name: 'nvwarp',
    ...(!nvwarp.isLoaded()
      ? { state: 'off' as const, detail: 'addon missing — GLSL warp/blend' }
      : nvwarp.isAvailable()
        ? { state: 'ok' as const, detail: 'NVAPI scanout warp/blend' }
        : { state: 'off' as const, detail: 'no NVAPI on this GPU — GLSL warp/blend' }),
  });
}

/** Host natives + main-plugin halves have all reported. */
export function markMainDone(): void { mainDone = true; notify(); }

/** The editor renderer reported its halves — the last wave. */
export function markRendererDone(): void { rendererDone = true; notify(); }

export function get(): BootReport { return snapshot(); }

export function subscribe(cb: (r: BootReport) => void): () => void {
  subs.add(cb);
  cb(snapshot()); // late subscribers get everything so far, immediately
  return () => { subs.delete(cb); };
}
