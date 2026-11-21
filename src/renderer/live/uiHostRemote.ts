// The host, as a plugin's UI half sees it in a PANEL WINDOW (E5/W5) — PluginUiHost over the two channels
// a client has.
//
//   READS  = this window's replicas: the 3D scene is the Show Host document's slice (state/docStore, kept
//            current by the host's patches), the settings are the editor's, from the 'editor.extras'
//            stream the panel store already reads (live/panelStore.tsx).
//   WRITES = a call to the editor (host/plugins.ts registers 'host.scene3DPatch' / 'host.menuAction'),
//            which runs it on the host's own service. So a zone drawn in a window takes exactly the path
//            a zone drawn in the editor takes, and the edit comes back here as a host patch like any other.
//
// The snapshots are stable references between changes (useSyncExternalStore re-renders on identity).

import type { PluginUiHost } from '@artlux/sdk/renderer';
import { docStore } from '../state/docStore';
import { liveClient } from './client';

const NONE = Object.freeze({});
let settings: unknown = NONE;
const settingsSubs = new Set<() => void>();
let stopExtras: (() => void) | null = null;
// One subscription for the window, opened by the first reader and kept: settings change rarely and the
// stream is already open for the panel store, so this costs the editor nothing while nobody changes them.
function watchSettings(): void {
  if (stopExtras) return;
  stopExtras = liveClient.subscribe('editor.extras', null, (v) => {
    const next = (v as { settings?: unknown } | null)?.settings ?? NONE;
    if (next === settings) return;
    settings = next;
    for (const cb of [...settingsSubs]) cb();
  });
}

const fail = (what: string) => (e: Error) => console.warn(`[panel] ${what} failed:`, e.message);

export const remoteUiHost: PluginUiHost = {
  settings: {
    get: () => { watchSettings(); return settings; },
    subscribe: (cb) => { watchSettings(); settingsSubs.add(cb); return () => { settingsSubs.delete(cb); }; },
  },
  scene3D: {
    get: () => docStore.getSlice('scene3D'),
    subscribe: (cb) => docStore.subscribeSlice('scene3D', cb),
    patch: (partial) => { liveClient.action('host.scene3DPatch', [partial]).catch(fail('scene patch')); },
  },
  ui: { menuAction: (a) => { liveClient.action('host.menuAction', [a]).catch(fail(`menu action ${a}`)); } },
};
