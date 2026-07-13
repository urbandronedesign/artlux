// Renderer-side thin client over the generic plugin IPC bridge (ctx.ipc → 'plugin:audio:*' → main).
// A module singleton (barrel-only import keeps it single, per the plugin contract). The renderer never
// touches the native addon directly (sandboxed); it drives the main-process engine through here.

import type { PluginIpc } from '@artlux/sdk/renderer';
// TYPE-only import: audioManager has top-level side effects (createRequire + loadNative). Importing a
// VALUE from it would drag node:module into the renderer bundle.
import type { AudioEffectSpec, ClipMeta, Meters, OutputMode, SpeakerLayout } from './audioManager';

let ipc: PluginIpc | null = null;
export function setIpc(i: PluginIpc): void { ipc = i; }

export const audioClient = {
  configure: (outputChannels: number, mode: OutputMode = 'binaural', layout: SpeakerLayout = 'stereo'): Promise<string> =>
    (ipc?.invoke('audio:configure', outputChannels, mode, layout) as Promise<string>) ?? Promise.resolve(''),
  getDevices: (): Promise<string[]> =>
    (ipc?.invoke('audio:getDevices') as Promise<string[]>) ?? Promise.resolve([]),
  getMeters: (): Promise<Meters> =>
    (ipc?.invoke('audio:getMeters') as Promise<Meters>) ??
    Promise.resolve({ peak: 0, rms: 0, peakL: 0, peakR: 0, peaks: [], speakers: 0, masterFxChannels: 0, deviceChannels: 0, clipped: false }),
  // Resolves false when the native addon is absent (or the bridge is dead — which also means no sound).
  // Consumers must not raise an alarm on a REJECTION: only an explicit false lights a warning.
  available: (): Promise<boolean> =>
    (ipc?.invoke('audio:available') as Promise<boolean>) ?? Promise.resolve(false),
  loadClip: (id: string, path: string): Promise<ClipMeta | null> =>
    (ipc?.invoke('audio:loadClip', id, path) as Promise<ClipMeta | null>) ?? Promise.resolve(null),
  unloadClip: (id: string): void => { ipc?.send('audio:unloadClip', id); },
  playClip: (id: string, seekSec: number, gain: number): void => { ipc?.send('audio:playClip', id, seekSec, gain); },
  stopClip: (id: string): void => { ipc?.send('audio:stopClip', id); },
  setClipGain: (id: string, gain: number): void => { ipc?.send('audio:setClipGain', id, gain); },
  // Ambisonic position — listener at origin, metres: +x right, +y up, +z forward.
  setClipSpatial: (id: string, x: number, y: number, z: number): void => { ipc?.send('audio:setClipSpatial', id, x, y, z); },
  clearClipSpatial: (id: string): void => { ipc?.send('audio:clearClipSpatial', id); },
  // Effect chains — the WHOLE chain each time; the engine diffs it (a params-only change updates in
  // place, no rebuild). Call these only when the chain actually changed, never on the playhead tick:
  // even the in-place path takes the audio lock.
  setClipEffects: (id: string, effects: AudioEffectSpec[]): void => { ipc?.send('audio:setClipEffects', id, effects); },
  setMasterEffects: (effects: AudioEffectSpec[]): void => { ipc?.send('audio:setMasterEffects', effects); },
  setMasterGain: (gain: number): void => { ipc?.send('audio:setMasterGain', gain); },
  stopAll: (): void => { ipc?.send('audio:stopAll'); },
};
