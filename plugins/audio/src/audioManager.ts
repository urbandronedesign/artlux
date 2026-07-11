// Graceful-degrade loader for the native JUCE audio engine (main process). Mirrors
// src/main/transport/outputManager.ts + plugins/ndi/src/ndiManager.ts: probe a few candidate paths,
// load the .node, and if it's absent/unloadable the whole subsystem is a no-op (audio disabled) —
// never a crash. The addon is built against Electron's ABI, so it loads only in the main process.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ClipMeta { durationSec: number; channels: number; sampleRate: number }
export interface Meters { peak: number; rms: number; peakL: number; peakR: number }

interface NativeAudio {
  juceVersion(): string;
  configure(outputChannels: number): string;   // returns opened device name; throws on failure
  getDevices(): string[];
  loadClip(id: string, path: string): ClipMeta; // throws if no decoder / file missing
  unloadClip(id: string): void;
  playClip(id: string, seekSec: number, gain: number): void;
  stopClip(id: string): void;
  setClipGain(id: string, gain: number): void;
  // Ambisonic position — listener at origin, metres: +x right, +y up, +z forward.
  setClipSpatial(id: string, x: number, y: number, z: number): void;
  clearClipSpatial(id: string): void;
  stopAll(): void;
  getMeters(): Meters;
  close(): void;
}

const req = createRequire(__filename);

function loadNative(): NativeAudio | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'audio-engine.node'),                        // packaged (extraResources)
    join(process.cwd(), 'native/audio-engine/build/Release/audio_engine.node'),    // dev (electron-vite)
    join(process.cwd(), 'native/audio-engine/audio_engine.node'),                  // copied build
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return req(p) as NativeAudio;
    } catch (e) {
      console.warn('[audio] native engine load failed at', p, e);
    }
  }
  return null;
}

const native = loadNative();
export const available = !!native;
console.log(
  native
    ? `[audio] native engine loaded (JUCE ${(() => { try { return native.juceVersion(); } catch { return '?'; } })()})`
    : '[audio] native engine unavailable — audio disabled',
);

// Thin, null-safe wrappers. Every call is a no-op (sensible default) when the engine is absent.
export function configure(outputChannels: number): string { return native ? native.configure(outputChannels) : ''; }
export function getDevices(): string[] { return native ? native.getDevices() : []; }
export function loadClip(id: string, path: string): ClipMeta | null { return native ? native.loadClip(id, path) : null; }
export function unloadClip(id: string): void { native?.unloadClip(id); }
export function playClip(id: string, seekSec: number, gain: number): void { native?.playClip(id, seekSec, gain); }
export function stopClip(id: string): void { native?.stopClip(id); }
export function setClipGain(id: string, gain: number): void { native?.setClipGain(id, gain); }
export function setClipSpatial(id: string, x: number, y: number, z: number): void { native?.setClipSpatial(id, x, y, z); }
export function clearClipSpatial(id: string): void { native?.clearClipSpatial(id); }
export function stopAll(): void { native?.stopAll(); }
export function getMeters(): Meters { return native ? native.getMeters() : { peak: 0, rms: 0, peakL: 0, peakR: 0 }; }
export function close(): void { native?.close(); }
