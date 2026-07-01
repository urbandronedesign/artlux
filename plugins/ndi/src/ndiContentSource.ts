import type { ContentSourceProvider } from '@artlux/sdk/renderer';
import type { SurfaceContent } from '@/types';
import { startNdi, stopNdi, getNdiCanvas } from './ndiReceiver';
import { NdiEditor } from './NdiEditor';

// The NDI content source: a single live receiver shared by every consumer (surface/clip), refcounted
// by consumer key — runs while ANY consumer wants it, stops the instant none do; the most-recently-
// acquired source wins on conflict. This owns the refcount that used to live in services/contentSource.

let seq = 0;
const consumers = new Map<string, { name: string; seq: number }>();
let active = false;
let activeName = '';

function reconcile(): void {
  let want = false, name = '', best = -1;
  for (const v of consumers.values()) { want = true; if (v.seq > best) { best = v.seq; name = v.name; } }
  if (want !== active || name !== activeName) {
    active = want; activeName = name;
    if (want) startNdi(name); else stopNdi();
  }
}

export const ndiContentSource: ContentSourceProvider<SurfaceContent> = {
  type: 'NDI', // SourceType.NDI — kept as a core enum value; only behavior lives here
  acquire(key, content) {
    const name = content.ndiName ?? '';
    const c = consumers.get(key);
    if (!c || c.name !== name) consumers.set(key, { name, seq: ++seq });
    reconcile();
  },
  release(key) {
    if (consumers.delete(key)) reconcile();
  },
  getDrawable() { return getNdiCanvas(); }, // single receiver — the consumer key is irrelevant
  // No getAspect → matches the host's prior behavior (NDI surfaces reported null aspect). getNdiAspect
  // exists in ndiReceiver if we ever want to wire it.
  editor: NdiEditor,
};
