// The DMX Monitor's feed in a PANEL WINDOW (E5/W5): the editor's output, over the live channel.
//
// ONE subscription per kind for the whole window, however many fixtures the monitor draws: 'dmx.pixels'
// (the canonical buffer, whole) while any pixel strip watches, 'dmx.universes' while any light's channel
// table does. Each is pulled once per frame this window draws (the broker's rule), and dropped with its
// last watcher. The editor's own monitor never comes here — it reads the bus (live/editorAccess.ts).
import { liveClient } from './client';
import type { DmxFeed, DmxFrameView } from '../services/dmxFeed';

type Kind = 'pixels' | 'universes';
let pixels = new Uint8Array(0);
let universes: Record<number, Uint8Array> = {};
const view: DmxFrameView = { get pixels() { return pixels; }, universe: (u) => universes[u] };

const subs: Record<Kind, Set<(f: DmxFrameView) => void>> = { pixels: new Set(), universes: new Set() };
const stops: Partial<Record<Kind, () => void>> = {};

function fan(kind: Kind): void { for (const cb of [...subs[kind]]) { try { cb(view); } catch (e) { console.warn('[dmx] monitor callback failed', e); } } }

function open(kind: Kind): void {
  if (stops[kind]) return;
  stops[kind] = kind === 'pixels'
    ? liveClient.subscribe('dmx.pixels', null, (v) => { pixels = (v as { bytes: Uint8Array }).bytes; fan('pixels'); })
    : liveClient.subscribe('dmx.universes', null, (v) => { universes = v as Record<number, Uint8Array>; fan('universes'); });
}

export const remoteDmxFeed: DmxFeed = {
  subscribe(needs, cb) {
    subs[needs].add(cb);
    open(needs);
    return () => {
      subs[needs].delete(cb);
      if (!subs[needs].size) { stops[needs]?.(); delete stops[needs]; }
    };
  },
};
