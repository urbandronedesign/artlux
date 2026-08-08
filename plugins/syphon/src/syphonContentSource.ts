import type { ContentSourceProvider } from '@artlux/sdk/renderer';
import type { SurfaceContent } from '@/types';
import { startSyphon, stopSyphon, getSyphonCanvas } from './syphonReceiver';
import { pollFps } from './syphonHost';
import { SyphonEditor } from './SyphonEditor';

// The Syphon content source: a single live receiver shared by every consumer (surface/clip),
// refcounted by consumer key — runs while ANY consumer wants it, stops the instant none do; the
// most-recently-acquired server wins on conflict. Mirrors spoutContentSource.

let seq = 0;
const consumers = new Map<string, { name: string; appName: string; seq: number }>();
let active = false;
let activeName = '';
let activeApp = '';
let activeFps = 0;

function reconcile(): void {
  let want = false, name = '', appName = '', best = -1;
  for (const v of consumers.values()) {
    want = true;
    if (v.seq > best) { best = v.seq; name = v.name; appName = v.appName; }
  }
  // The poll rate is part of what "the receiver is configured correctly" MEANS, so it belongs in the
  // same comparison as the server identity — otherwise a rate change is a no-op whenever the server
  // is unchanged, which is every time.
  const fps = pollFps();
  if (want !== active || name !== activeName || appName !== activeApp || (want && fps !== activeFps)) {
    active = want; activeName = name; activeApp = appName; activeFps = fps;
    if (want) startSyphon(name, appName, fps); else stopSyphon();
  }
}

// Re-evaluate after something OUTSIDE the consumer set changed — today only the engine rate.
// Exported for the plugin's settings subscription; reconcile() itself stays private so there is one
// door.
export function reconcileSyphon(): void { reconcile(); }

export const syphonContentSource: ContentSourceProvider<SurfaceContent> = {
  type: 'SYPHON', // SourceType.SYPHON — kept as a core enum value; only behavior lives here
  acquire(key, content) {
    const name = content.syphonName ?? '';
    const appName = content.syphonAppName ?? '';
    const c = consumers.get(key);
    if (!c || c.name !== name || c.appName !== appName) consumers.set(key, { name, appName, seq: ++seq });
    reconcile();
  },
  release(key) {
    if (consumers.delete(key)) reconcile();
  },
  getDrawable() { return getSyphonCanvas(); }, // single receiver — the consumer key is irrelevant
  // No getAspect → matches Spout's behaviour (GPU-share surfaces report null aspect).
  // getSyphonAspect exists in syphonReceiver if we ever want to wire it.
  editor: SyphonEditor,
};
