// Host-side first-party plugin activation (main process).
//
// Builds the main plugin context (a generic IPC handle namespaced under 'plugin:<ch>' and bound to
// the active window) and activates each registered main plugin once. Called from registerIpc.
//
// …AND DEACTIVATION, which until now NOTHING CALLED. Every main plugin could declare `deactivate()`,
// the SDK documented it, six of them implemented it — and no code path in the app ever invoked one.
// For most that is a leak nobody sees, because the process is ending anyway. For the audio plugin it
// was a hard crash: `deactivate` closes the JUCE engine (`gEngine.reset()`), and without it the
// engine's unique_ptr is a namespace-scope global, so `juce::AudioDeviceManager`'s destructor ran from
// `__cxa_finalize` at process exit — after JUCE's own statics were gone — and unhooking its MIDI
// device-list connection segfaulted. That is the macOS "quitting crashes the app" report, and it was
// SIGSEGV in audio-engine.node every time. Teardown must happen while the process is still alive.

import { ipcMain, type BrowserWindow } from 'electron';
import type { MainPlugin, MainPluginContext, MainPluginIpc, PluginStatus } from '@artlux/sdk/main';
import * as bootReport from '../bootReport';
import { plugin as ndi } from '@artlux/plugin-ndi/main';
import { plugin as calibration } from '@artlux/plugin-calibration/main';
import { plugin as spout } from '@artlux/plugin-spout/main';
import { plugin as hap } from '@artlux/plugin-hap/main';
import { plugin as showControl } from '@artlux/plugin-show-control/main';
import { plugin as audio } from '@artlux/plugin-audio/main';
import { plugin as shader } from '@artlux/plugin-shader/main';

const FIRST_PARTY: MainPlugin[] = [ndi, calibration, spout, hap, showControl, audio, shader];

let activated = false;
let deactivated = false;

function makeContext(getWindow: () => BrowserWindow | null): MainPluginContext {
  const ipc: MainPluginIpc = {
    handle(channel, handler) { ipcMain.handle('plugin:' + channel, (_e, ...args) => handler(...args)); },
    on(channel, handler) { ipcMain.on('plugin:' + channel, (_e, ...args) => handler(...args)); },
    send(channel, ...args) { getWindow()?.webContents.send('plugin:' + channel, ...args); },
  };
  // Same window `ipc.send` targets — for the Electron APIs that need the window itself rather than a
  // message (handing over a GPU shared texture, which is not clonable and so cannot use `ipc`).
  return { ipc, window: () => getWindow() };
}

export function activateMainPlugins(getWindow: () => BrowserWindow | null): void {
  if (activated) return;
  activated = true;
  const ctx = makeContext(getWindow);
  // The host's own natives first, so the splash's console reads bottom-up in load order: the addons
  // that were loaded at import time, then the plugins that use them.
  bootReport.recordHostNatives();
  for (const p of FIRST_PARTY) {
    const t0 = performance.now();
    try {
      p.activate(ctx);
      // A plugin that reports nothing is 'ok' — most renderer-only ones have nothing to be unsure
      // about. A THROWING status() must not become a failed activation: the plugin is up, its
      // self-report is broken, and downgrading it to 'error' would be a lie about the feature.
      let st: PluginStatus = { state: 'ok' };
      if (p.status) {
        try { st = p.status(); } catch (e) { console.warn(`[plugins:main] ${p.manifest.id} status() threw`, e); }
      }
      bootReport.record({
        group: 'main', id: p.manifest.id, name: p.manifest.name,
        state: st.state, detail: st.detail, ms: Math.round(performance.now() - t0),
      });
    } catch (e) {
      console.error(`[plugins:main] ${p.manifest.id} activate failed`, e);
      // This used to exist ONLY as that console.error, so a plugin that threw at activation left no
      // trace anywhere an operator would look. Now it is a red line on the splash.
      bootReport.record({
        group: 'main', id: p.manifest.id, name: p.manifest.name, state: 'error',
        detail: firstLine(e), ms: Math.round(performance.now() - t0),
      });
    }
  }
  bootReport.markMainDone();
}

/**
 * Tear the main plugins down while the process is still a process. Called from `will-quit` and from
 * every relaunch path (see index.ts / watchdog.ts), all of which end in `app.exit()`.
 *
 * Reverse activation order, and each one wrapped: this runs on the way out, so a plugin that throws
 * here must not take the ones after it with it — the audio engine in particular MUST get its close()
 * or the process dies in a static destructor instead of exiting. Idempotent, because more than one
 * path out of the process can reach it.
 */
export function deactivateMainPlugins(): void {
  if (!activated || deactivated) return;
  deactivated = true;
  for (const p of [...FIRST_PARTY].reverse()) {
    try { p.deactivate?.(); } catch (e) { console.error(`[plugins:main] ${p.manifest.id} deactivate failed`, e); }
  }
}

// An error's first line only: the splash gives each row one line, and a stack would blow the column.
function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return (msg.split('\n')[0] ?? 'activate failed').slice(0, 120);
}
