// The takes docks in a PANEL WINDOW (E5/W5j): the editor's take recorder, over the live channel.
//   STATE — the 'takes.state' stream: recording flags, elapsed, live blobs, orphan files. Elapsed is
//           re-anchored at every sample (once a second while recording) and counted here in between.
//   NUDGES — one 'takes.*' call per command; the editor's recorder runs it and the document changes come
//           back through the Show Host like any edit.
//   DENSITY — a take's sparkline, asked once per path ('takes.density') and kept.
import { liveClient } from './client';
import { setTakesAccess, type RecState, type TakeKind } from '../services/takesAccess';
import { setTakeDensitySource, type TakeDensity } from '../services/takeDensity';
import { setThumbView } from '../services/thumbView';

type State = { rec: RecState; elapsed: Record<TakeKind, number>; blobs: number; orphans: string[] };
let state: State = { rec: { lighting: false, tracking: false }, elapsed: { lighting: 0, tracking: 0 }, blobs: 0, orphans: [] };
let at = 0;
const subs = new Set<() => void>();
let stop: (() => void) | null = null;
function open(): void {
  if (stop) return;
  stop = liveClient.subscribe('takes.state', null, (v) => {
    const s = v as State;
    // Keep identities stable when unchanged (useSyncExternalStore re-renders on identity).
    const rec = s.rec.lighting === state.rec.lighting && s.rec.tracking === state.rec.tracking ? state.rec : s.rec;
    const orphans = JSON.stringify(s.orphans) === JSON.stringify(state.orphans) ? state.orphans : s.orphans;
    state = { ...s, rec, orphans };
    at = performance.now();
    for (const cb of [...subs]) cb();
  });
}
const fail = (what: string) => (e: Error) => console.warn(`[panel] ${what} failed:`, e.message);
const call = (name: string, args: unknown[]) => { liveClient.action(name, args).catch(fail(name)); };

const density = new Map<string, TakeDensity | null>();

// Stills for the media library's chips: asked of the editor once per (path, time); an answer of "none"
// (not decodable yet, or the ask timed out) may be asked again after a while, never in a loop.
const stills = new Map<string, ImageBitmap | null>();
const asked = new Map<string, number>();
const thumbSubs = new Set<(path: string) => void>();
const RETRY_MS = 5000;

export function installTakesRemote(): void {
  setTakesAccess({
    subscribe(cb) {
      open();
      subs.add(cb);
      return () => { subs.delete(cb); if (!subs.size) { stop?.(); stop = null; } };
    },
    getRec: () => state.rec,
    elapsed: (k) => state.elapsed[k] + (state.rec[k] ? (performance.now() - at) / 1000 : 0),
    liveBlobs: () => state.blobs,
    orphans: () => state.orphans,
    toggle: (k) => call('takes.toggle', [k]),
    cancel: (k) => call('takes.cancel', [k]),
    addLane: (k) => call('takes.addLane', [k]),
    rename: (k, id, name) => call('takes.rename', [k, id, name]),
    remove: (k, id) => call('takes.remove', [k, id]),
  });
  setThumbView({
    getThumb(path, time) {
      const key = `${path}@${time}`;
      const have = stills.get(key);
      if (have) return have;
      const last = asked.get(key);
      if (last == null || (have === null && performance.now() - last > RETRY_MS)) {
        asked.set(key, performance.now());
        void liveClient.thumb(path, time).then((bmp) => {
          stills.set(key, bmp);
          if (bmp) for (const cb of [...thumbSubs]) cb(path);
        });
      }
      return undefined;
    },
    onThumb(cb) { thumbSubs.add(cb); return () => { thumbSubs.delete(cb); }; },
  });
  setTakeDensitySource({
    getCached: (p) => density.get(p) ?? null,
    async ensure(p) {
      if (density.has(p)) return density.get(p) ?? null;
      const d = (await liveClient.action('takes.density', [p]).catch(() => null)) as TakeDensity | null;
      density.set(p, d);
      return d;
    },
  });
}
