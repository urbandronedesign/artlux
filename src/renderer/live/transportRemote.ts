// THE TIMELINE IN A PANEL WINDOW (E5 — the detached timeline): the transport, the waveforms and the OSC
// sender it reads, over the live channel. The editor's own timeline reads the services (live/editorAccess.ts).
//
//   TRANSPORT — the editor's CLOCK ANCHORS (W4), extrapolated here every frame of THIS window: the playhead
//               runs smooth on this screen with no message per frame; a new anchor arrives only when the
//               editor's clock stops agreeing with the last one (a seek, a pause, a wrap). Seek and Stop
//               are the editor's ('transport.*'), and so is "held at end" (a 4 Hz badge, sent on a flip).
//   WAVEFORMS — the editor's decode (`liveClient.peaks`): each file asked for once, at full resolution, and
//               reduced here exactly as the editor reduces it (audioPeaks.peaksFor). Nothing decodes here.
//   OSC       — an OSC track's counters ('osc.stats', sent on change) and its Resend / Test buttons.
//
// Stills for the filmstrips already come from the editor (live/takesRemote.ts installs services/thumbView).
import { liveClient } from './client';
import { setTransportView } from '../services/transportView';
import { setPeaksView } from '../services/peaksView';
import { setOscTrackView } from '../services/oscTrackView';
import { setShowContext } from '../services/editorShell';
import type { OscTrackConfig } from '../types';

const fail = (what: string) => (e: Error) => { console.warn(`[panel] ${what} failed:`, e.message); };
const call = (name: string, args: unknown[]) => { liveClient.action(name, args).catch(fail(name)); };

// ── TRANSPORT ────────────────────────────────────────────────────────────────────────────────────
// Every frame while anyone listens, as the editor's transport ticks every frame "even when paused" (its
// subscribers — the playhead line, the time readouts, the lanes' live values — rely on that and start no
// timer of their own). The clock watch is held for as long as there is a listener: that is what makes the
// editor send anchors at all.
const playheadSubs = new Set<(t: number) => void>();
let raf = 0;
let unwatch: (() => void) | null = null;
function frame(): void {
  raf = requestAnimationFrame(frame);
  const c = liveClient.now();
  const t = c ? c.playhead : 0;
  for (const cb of [...playheadSubs]) { try { cb(t); } catch (e) { console.warn('[panel] playhead subscriber threw', e); } }
}
function startClock(): void {
  if (unwatch) return;
  unwatch = liveClient.watchClock();
  raf = requestAnimationFrame(frame);
}
function stopClock(): void {
  cancelAnimationFrame(raf);
  unwatch?.(); unwatch = null;
}

let held = false;
let heldStop: (() => void) | null = null;
function watchHeld(): void {
  if (heldStop) return;
  heldStop = liveClient.subscribe('transport.held', null, (v) => { held = !!v; });
}

// ── WAVEFORMS ────────────────────────────────────────────────────────────────────────────────────
const FULL = 0x7fffffff;          // "every bucket the editor has" — the broker caps it at the cache's own length
const RETRY_MS = 5000;            // a file the editor could not decode in time may be asked again, never in a loop
const peaks = new Map<string, Float32Array>();
const durations = new Map<string, number>();
const askedAt = new Map<string, number>();
const peakSubs = new Set<() => void>();
function askPeaks(path: string): void {
  if (peaks.has(path)) return;
  const last = askedAt.get(path);
  if (last != null && performance.now() - last < RETRY_MS) return;
  askedAt.set(path, performance.now());
  void liveClient.peaks(path, FULL).then(({ peaks: p, duration }) => {
    if (p) peaks.set(path, p);
    if (duration != null) durations.set(path, duration);
    for (const cb of [...peakSubs]) cb();
  });
}
// The editor's own reduction (components/timeline/audioPeaks.ts peaksFor): max per bucket.
function reduce(full: Float32Array, buckets: number): Float32Array {
  if (buckets >= full.length) return full;
  const out = new Float32Array(buckets);
  const per = full.length / buckets;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const s = Math.floor(b * per), e = Math.max(s + 1, Math.floor((b + 1) * per));
    for (let i = s; i < e && i < full.length; i++) if (full[i] > m) m = full[i];
    out[b] = m;
  }
  return out;
}

// ── OSC ──────────────────────────────────────────────────────────────────────────────────────────
let oscStats: Record<string, { sent: number; count: number }> = {};
let oscStop: (() => void) | null = null;

export function installTransportRemote(): void {
  setTransportView({
    getPlayhead: () => liveClient.now()?.playhead ?? 0,
    getShowTime: () => liveClient.now()?.showTime ?? 0,
    subscribe(cb) {
      playheadSubs.add(cb);
      startClock();
      return () => { playheadSubs.delete(cb); if (!playheadSubs.size) stopClock(); };
    },
    seek: (t) => call('transport.seek', [t]),
    stop: () => call('transport.stop', []),
    isBoundHeld: () => { watchHeld(); return held; },
  });
  setPeaksView({
    subscribe(cb) { peakSubs.add(cb); return () => { peakSubs.delete(cb); }; },
    ensure: (p) => askPeaks(p),
    peaksFor(p, buckets) {
      const full = peaks.get(p);
      if (!full) { askPeaks(p); return null; }
      return reduce(full, Math.max(1, buckets | 0));
    },
    sourceDuration: (p) => durations.get(p) ?? null,
    probeDuration: (p) => liveClient.action('audio.probeDuration', [p]).then((v) => (typeof v === 'number' ? v : null)).catch(() => null),
  });
  setOscTrackView({
    stats(p) {
      if (!oscStop) oscStop = liveClient.subscribe('osc.stats', null, (v) => { oscStats = (v ?? {}) as typeof oscStats; });
      return oscStats[p] ?? null;
    },
    resend: (p) => call('osc.resend', [p]),
    sendTest: (cfg: OscTrackConfig, v: number) => call('osc.test', [cfg, v]),
  });
  // "Edit logic": the EDITOR goes to the Show Machine (this window has no workbench to switch).
  setShowContext((id) => call('shell.goToContext', [id]));
}
