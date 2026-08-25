// Renderer-side thin client over the generic plugin IPC bridge (ctx.ipc → 'plugin:audio:*' → main).
// A module singleton (barrel-only import keeps it single, per the plugin contract). The renderer never
// touches the native addon directly (sandboxed); it drives the main-process engine through here.

import type { PluginIpc } from '@artlux/sdk/renderer';
// TYPE-only import: audioManager has top-level side effects (createRequire + loadNative). Importing a
// VALUE from it would drag node:module into the renderer bundle.
import type { AudioEffectSpec, ClipMeta, DeviceCfg, DeviceEntry, Meters, OpenedCfg } from './audioManager';

let ipc: PluginIpc | null = null;
export function setIpc(i: PluginIpc): void { ipc = i; }

export const audioClient = {
  configure: (cfg: DeviceCfg): Promise<OpenedCfg> =>
    (ipc?.invoke('audio:configure', cfg) as Promise<OpenedCfg>) ??
    Promise.resolve({ deviceName: '', deviceType: '', sampleRate: 0, bufferSize: 0, channels: 0 }),
  getDevices: (): Promise<DeviceEntry[]> =>
    (ipc?.invoke('audio:getDevices') as Promise<DeviceEntry[]>) ?? Promise.resolve([]),
  getMeters: (): Promise<Meters> =>
    (ipc?.invoke('audio:getMeters') as Promise<Meters>) ??
    // `deviceLive: true` on a dead BRIDGE, for the same reason audioManager's no-addon fallback does it: a
    // dead bridge is not a dead audio interface, and pointing the operator at their USB cable when the
    // problem is elsewhere is worse than saying nothing. Each badge answers exactly one question.
    Promise.resolve({ peak: 0, rms: 0, peakL: 0, peakR: 0, peaks: [], speakers: 0, masterFxChannels: 0, deviceChannels: 0, clipped: false, deviceLive: true }),
  // The commissioning blip source, generated on demand in main. Null when it cannot be written.
  testSource: (): Promise<string | null> =>
    (ipc?.invoke('audio:testSource') as Promise<string | null>) ?? Promise.resolve(null),
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
  setClipSpatial: (id: string, x: number, y: number, z: number, omni?: boolean): void => { ipc?.send('audio:setClipSpatial', id, x, y, z, omni === true); },
  clearClipSpatial: (id: string): void => { ipc?.send('audio:clearClipSpatial', id); },
  // Effect chains — the WHOLE chain each time; the engine diffs it (a params-only change updates in
  // place, no rebuild). Call these only when the chain actually changed, never on the playhead tick:
  // even the in-place path takes the audio lock.
  setClipEffects: (id: string, effects: AudioEffectSpec[]): void => { ipc?.send('audio:setClipEffects', id, effects); },
  setMasterEffects: (effects: AudioEffectSpec[]): void => { ipc?.send('audio:setMasterEffects', effects); },
  setMasterGain: (gain: number): void => { ipc?.send('audio:setMasterGain', gain); },
  // Commissioning only. Pink noise straight onto a DEVICE CHANNEL, bypassing the decoder and the master
  // fader. deviceChannel < 0 stops it. Never call this from the playhead tick.
  setTestTone: (deviceChannel: number, gain = 0.5): void => { ipc?.send('audio:setTestTone', deviceChannel, gain); },
  stopAll: (): void => { ipc?.send('audio:stopAll'); },
};
