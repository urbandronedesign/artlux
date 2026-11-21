// How the Augmenta plugin's UI half reaches the host (E5/W5): the PluginUiHost handed `activateUi`.
//
// The Augmenta Monitor is drawn in the editor AND in a panel window. It taps the OSC wire itself (main
// sends OSC to any window that listens) and reads the listener settings from here: the editor's own
// settings service there, the window's copy of the editor's settings in a panel window.
import { useSyncExternalStore } from 'react';
import type { PluginUiHost } from '@artlux/sdk/renderer';

let host: PluginUiHost | null = null;
export function setUiHost(h: PluginUiHost): void { host = h; }

// The subset of AppSettings the Augmenta Monitor reads. (AppSettings is a core type; we only need
// these — Augmenta shares the host's single OSC listener, so the box points at oscListenPort.)
export interface OscSettings {
  oscEnabled?: boolean;
  oscListenPort?: number;
  oscListenAddress?: string;
}

// Stable snapshot between changes (useSyncExternalStore re-renders on identity): the host's get()
// returns the live settings object; EMPTY covers a window with no host.
const EMPTY: OscSettings = Object.freeze({});
export function useHostSettings(): OscSettings {
  return useSyncExternalStore(
    (cb) => host?.settings.subscribe(cb) ?? (() => {}),
    () => ((host?.settings.get() as OscSettings | undefined) ?? EMPTY),
  );
}
