// Graceful-degrade loader for the native JUCE audio engine (main process). Mirrors
// src/main/transport/outputManager.ts + plugins/ndi/src/ndiManager.ts: probe a few candidate paths,
// load the .node, and if it's absent/unloadable the whole subsystem is a no-op (audio disabled) —
// never a crash. The addon is built against Electron's ABI, so it loads only in the main process.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ClipMeta { durationSec: number; channels: number; sampleRate: number }
export interface Meters {
  peak: number; rms: number; peakL: number; peakR: number; peaks: number[]; speakers: number;
  // An effect chain built for a different channel count than the audio thread sees passes DRY — it looks
  // wired and meters normally. These two make that measurable instead of invisible.
  masterFxChannels: number; deviceChannels: number;
  // LATCHED in the engine and cleared on read: true if ANY block clipped since the last poll. `peak` is
  // one block's peak and we poll at ~10 Hz, so a clip indicator derived from it would miss most clipping.
  clipped: boolean;
  // ⚠ IS THERE A DEVICE — **NOT** "did the addon load", which is what `audio:available` answers.
  // Unplug the interface and the .node stays perfectly loaded, so `available` stays true and Preferences went
  // on printing "engine active · output device: <the dead one>" over a silent room. This is the ground truth,
  // read from JUCE's getCurrentAudioDevice() on the poll that already runs. `false` here ⇒ THERE IS NO SOUND.
  //
  // Defaults TRUE at every degraded read (see getMeters below): a missing addon is a different failure with
  // its own badge, and lighting BOTH would tell the operator two things are broken when one is.
  deviceLive: boolean;
}

// One effect node, as the engine wants it. Mirrors AudioEffect in src/renderer/types.ts — `params` are
// continuous (automatable), `opts` are discrete choices (filter mode) and never fadeable.
export interface AudioEffectSpec {
  id: string;
  type: string;
  bypass?: boolean;
  params?: Record<string, number>;
  opts?: Record<string, string>;
}

// How the ambisonic field is rendered: binaural HRTF (headphones) or a decode to a real speaker layout.
export type OutputMode = 'binaural' | 'speakers';
export type SpeakerLayout = 'stereo' | 'quad' | '5.0' | '5.1' | '7.0' | '7.1' | 'hexagon' | 'octagon' | 'cube';

// The setup we ASK the engine for. An absent deviceName means "that driver type's default device" —
// today's behaviour, preserved. sampleRate/bufferSize of 0 mean "the device's default".
export interface DeviceCfg {
  deviceType?: string;
  deviceName?: string;
  channels?: number;
  sampleRate?: number;
  bufferSize?: number;
  mode?: OutputMode;
  layout?: SpeakerLayout;
  // Decoder speaker → device channel, e.g. patch[2] = 5 means "decoder speaker 3 comes out of device
  // channel 6". Live and decoder-only (engine.cpp Bus::setPatch) — changing it never reopens the device.
  // Absent/short ⇒ identity for the missing slots. The native sanitiser REMAPS (never drops) a duplicate
  // destination, so two speakers pointed at the same channel are silently moved apart — see
  // AudioSettings.tsx's inline warning, which tells the operator that before the engine does it for them.
  patch?: number[];
}
// What the engine ACTUALLY OPENED — not what we asked for. A stereo card asked for 8 channels reports 2
// back. The UI must render THIS, or Preferences describes a rig that does not exist.
export interface OpenedCfg {
  deviceName: string; deviceType: string; sampleRate: number; bufferSize: number; channels: number;
}
// One physical interface appears once PER DRIVER TYPE. That is the point: the type is what decides whether
// you get discrete multichannel (WASAPI *exclusive*) or a shared mix (WASAPI shared).
export interface DeviceEntry { type: string; name: string; isDefault: boolean }

interface NativeAudio {
  juceVersion(): string;
  configure(cfg: DeviceCfg): OpenedCfg; // throws on failure
  getDevices(): DeviceEntry[];
  loadClip(id: string, path: string): ClipMeta; // throws if no decoder / file missing
  unloadClip(id: string): void;
  playClip(id: string, seekSec: number, gain: number): void;
  stopClip(id: string): void;
  setClipGain(id: string, gain: number): void;
  // Ambisonic position — listener at origin, metres: +x right, +y up, +z forward.
  setClipSpatial(id: string, x: number, y: number, z: number, omni?: boolean): void;
  clearClipSpatial(id: string): void;
  // Insert chain on one source, applied BEFORE it is spatialised. Replaces the whole chain; the engine
  // diffs it and updates params in place when only values changed (no rebuild, no click).
  setClipEffects(id: string, effects: AudioEffectSpec[]): void;
  // Insert chain on the decoded output. 'reverb' nodes are dropped by the engine (see AudioEffectType).
  setMasterEffects(effects: AudioEffectSpec[]): void;
  setMasterGain(gain: number): void;
  // Commissioning only. Pink noise straight onto a DEVICE CHANNEL, bypassing the decoder and the master
  // fader (engine.cpp Bus::setTestTone). deviceChannel < 0 turns it off.
  setTestTone(deviceChannel: number, gain: number): void;
  stopAll(): void;
  getMeters(): Meters;
  /**
   * 16 log-spaced bands of the mixed output, 0..1 each.
   *
   * OPTIONAL because the addon on disk may predate it: a venue that has not rebuilt the engine still
   * loads, still plays, and reports silence to anything reacting to sound — which is the graceful
   * degradation every other native feature here follows, rather than a crash on the first frame.
   */
  getSpectrum?(): Float32Array;
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
const NO_DEVICE: OpenedCfg = { deviceName: '', deviceType: '', sampleRate: 0, bufferSize: 0, channels: 0 };
export function configure(cfg: DeviceCfg): OpenedCfg { return native ? native.configure(cfg) : NO_DEVICE; }
export function getDevices(): DeviceEntry[] { return native ? native.getDevices() : []; }
export function loadClip(id: string, path: string): ClipMeta | null { return native ? native.loadClip(id, path) : null; }
export function unloadClip(id: string): void { native?.unloadClip(id); }
export function playClip(id: string, seekSec: number, gain: number): void { native?.playClip(id, seekSec, gain); }
export function stopClip(id: string): void { native?.stopClip(id); }
export function setClipGain(id: string, gain: number): void { native?.setClipGain(id, gain); }
// `omni` is OPTIONAL all the way down to the addon, which defaults it to false — so a venue running an
// older audio_engine.node against this renderer keeps working, with omni sources simply playing at their
// stored bearing instead of everywhere.
export function setClipSpatial(id: string, x: number, y: number, z: number, omni?: boolean): void { native?.setClipSpatial(id, x, y, z, omni === true); }
export function clearClipSpatial(id: string): void { native?.clearClipSpatial(id); }
export function setClipEffects(id: string, effects: AudioEffectSpec[]): void { native?.setClipEffects(id, effects); }
export function setMasterEffects(effects: AudioEffectSpec[]): void { native?.setMasterEffects(effects); }
export function setMasterGain(gain: number): void { native?.setMasterGain(gain); }
export function setTestTone(deviceChannel: number, gain: number): void { native?.setTestTone(deviceChannel, gain); }
export function stopAll(): void { native?.stopAll(); }
export function getMeters(): Meters {
  return native
    ? native.getMeters()
    // ⚠ `deviceLive: true` WITH NO ADDON AT ALL, AND THAT IS DELIBERATE. There is obviously no device here —
    // but "the addon did not load" is a DIFFERENT failure with its OWN badge (`no audio engine`, and a
    // startup modal). Reporting `false` too would light BOTH, telling the operator two things are broken
    // when one is, and pointing them at a USB cable when the actual problem is a missing build. Each badge
    // answers exactly one question. See Meters.deviceLive.
    : { peak: 0, rms: 0, peakL: 0, peakR: 0, peaks: [], speakers: 0, masterFxChannels: 0, deviceChannels: 0, clipped: false, deviceLive: true };
}
/**
  * The mixed output as 16 log-spaced bands, 0..1 each. Empty when there is no engine.
  *
  * A SEPARATE CALL FROM getMeters, because it is polled at a different rate: meters are a ~10 Hz
  * readout for a human eye, while a visual reacting to sound wants one per rendered frame. Bundling
  * them would force one of the two to be wrong.
  */
export function getSpectrum(): Float32Array { return native?.getSpectrum?.() ?? EMPTY_SPECTRUM; }
const EMPTY_SPECTRUM = new Float32Array(16);

export function close(): void { native?.close(); }
