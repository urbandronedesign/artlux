import type { ContentSourceProvider } from '@artlux/sdk/renderer';
import type { SurfaceContent } from '@/types';
import { startSpout, stopSpout, getSpoutCanvas } from './spoutReceiver';
import { SpoutEditor } from './SpoutEditor';

// The Spout content source: a single live receiver shared by every consumer (surface/clip), refcounted
// by consumer key — runs while ANY consumer wants it, stops the instant none do; the most-recently-
// acquired sender wins on conflict. This owns the refcount that used to live in services/contentSource
// (the `reconcileSpout` singleton). Mirrors ndiContentSource.

let seq = 0;
const consumers = new Map<string, { name: string; seq: number }>();
let active = false;
let activeName = '';

function reconcile(): void {
  let want = false, name = '', best = -1;
  for (const v of consumers.values()) { want = true; if (v.seq > best) { best = v.seq; name = v.name; } }
  if (want !== active || name !== activeName) {
    active = want; activeName = name;
    if (want) startSpout(name); else stopSpout();
  }
}

export const spoutContentSource: ContentSourceProvider<SurfaceContent> = {
  type: 'SPOUT', // SourceType.SPOUT — kept as a core enum value; only behavior lives here
  acquire(key, content) {
    const name = content.spoutName ?? '';
    const c = consumers.get(key);
    if (!c || c.name !== name) consumers.set(key, { name, seq: ++seq });
    reconcile();
  },
  release(key) {
    if (consumers.delete(key)) reconcile();
  },
  getDrawable() { return getSpoutCanvas(); }, // single receiver — the consumer key is irrelevant
  // No getAspect → matches the host's prior behavior (Spout surfaces reported null aspect).
  // getSpoutAspect exists in spoutReceiver if we ever want to wire it.
  editor: SpoutEditor,
};
