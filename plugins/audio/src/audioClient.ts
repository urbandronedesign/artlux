// Renderer-side thin client over the generic plugin IPC bridge (ctx.ipc → 'plugin:audio:*' → main).
// A module singleton (barrel-only import keeps it single, per the plugin contract). The renderer never
// touches the native addon directly (sandboxed); it drives the main-process engine through here.

import type { PluginIpc } from '@artlux/sdk/renderer';
import type { ClipMeta, Meters, OutputMode, SpeakerLayout } from './audioManager';

let ipc: PluginIpc | null = null;
export function setIpc(i: PluginIpc): void { ipc = i; }

export const audioClient = {
  configure: (outputChannels: number, mode: OutputMode = 'binaural', layout: SpeakerLayout = 'stereo'): Promise<string> =>
    (ipc?.invoke('audio:configure', outputChannels, mode, layout) as Promise<string>) ?? Promise.resolve(''),
  getDevices: (): Promise<string[]> =>
    (ipc?.invoke('audio:getDevices') as Promise<string[]>) ?? Promise.resolve([]),
  getMeters: (): Promise<Meters> =>
    (ipc?.invoke('audio:getMeters') as Promise<Meters>) ?? Promise.resolve({ peak: 0, rms: 0, peakL: 0, peakR: 0, peaks: [], speakers: 0 }),
  loadClip: (id: string, path: string): Promise<ClipMeta | null> =>
    (ipc?.invoke('audio:loadClip', id, path) as Promise<ClipMeta | null>) ?? Promise.resolve(null),
  unloadClip: (id: string): void => { ipc?.send('audio:unloadClip', id); },
  playClip: (id: string, seekSec: number, gain: number): void => { ipc?.send('audio:playClip', id, seekSec, gain); },
  stopClip: (id: string): void => { ipc?.send('audio:stopClip', id); },
  setClipGain: (id: string, gain: number): void => { ipc?.send('audio:setClipGain', id, gain); },
  // Ambisonic position — listener at origin, metres: +x right, +y up, +z forward.
  setClipSpatial: (id: string, x: number, y: number, z: number): void => { ipc?.send('audio:setClipSpatial', id, x, y, z); },
  clearClipSpatial: (id: string): void => { ipc?.send('audio:clearClipSpatial', id); },
  stopAll: (): void => { ipc?.send('audio:stopAll'); },
};
