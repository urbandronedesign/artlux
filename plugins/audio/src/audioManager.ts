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

type MaybeAsync<T> = T | Promise<T>;
// A synchronous throw from an older build becomes a rejection, so callers see ONE failure shape.
function settle<T>(f: () => MaybeAsync<T>): Promise<T> { try { return Promise.resolve(f()); } catch (e) { return Promise.reject(e); } }

interface NativeAudio {
  /**
   * NON-REALTIME RENDERING. Detaches the device, prepares the graph at an arbitrary rate, and lets the
   * caller pull blocks as fast as the disk allows. Three calls rather than one render() because the
   * driver has to evaluate automation, fades and recalls BETWEEN blocks, exactly as it does per frame
   * live. `offlinePull` returns INTERLEAVED frames (frames * channels).
   */
  // ⚠ ASYNC IN A CURRENT BUILD: every call that touches the engine runs on the addon's own audio control
  // thread (engine.cpp, "THE ENGINE DOES NOT RUN ON THE JS THREAD"), and the answering ones return a
  // PROMISE — a cold device open is seconds, and it used to stall main for all of them. An engine built
  // before that returns the value itself; the wrappers below take either (Promise.resolve).
  offlineBegin?(cfg: { sampleRate: number; blockSize: number; channels: number }): MaybeAsync<{ ok: boolean; error?: string }>;
  offlinePull?(frames: number): MaybeAsync<Float32Array>;
  offlineEnd?(): MaybeAsync<void>;

  juceVersion(): string;
  configure(cfg: DeviceCfg): MaybeAsync<OpenedCfg>; // rejects (an older build: throws) on failure
  getDevices(): MaybeAsync<DeviceEntry[]>;
  loadClip(id: string, path: string): MaybeAsync<ClipMeta>; // rejects if no decoder / file missing
  unloadClip(id: string): void;
  playClip(id: string, seekSec: number, gain: number): void;
  stopClip(id: string): void;
  /** E3p: the native engine's only — the addon has no clock of its own to hold a clip to. */
  lockClip?(id: string, lock: ClipLock | null): void;
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
  getMeters(): MaybeAsync<Meters>;
  /**
   * 16 log-spaced bands of the mixed output, 0..1 each.
   *
   * OPTIONAL because the addon on disk may predate it: a venue that has not rebuilt the engine still
   * loads, still plays, and reports silence to anything reacting to sound — which is the graceful
   * degradation every other native feature here follows, rather than a crash on the first frame.
   */
  getSpectrum?(): MaybeAsync<Float32Array>;
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

// The addon. `native` is what every call below goes through: the addon, or — E3m, sound from the native engine —
// the engine relay (useEngineAudio), offline renders included.
const addon = loadNative();
let native: NativeAudio | null = addon;
export let available = !!native;
console.log(
  native
    ? `[audio] native engine loaded (JUCE ${(() => { try { return native.juceVersion(); } catch { return '?'; } })()})`
    : '[audio] native engine unavailable — audio disabled',
);

/**
 * E3m — PLAY THROUGH THE NATIVE ENGINE. Every live call from here on is relayed (by the addon's own method name and
 * arguments) to the JUCE inside the engine process — the same core as the addon (native/audio-engine/src/core.h,
 * built as artlux_audio.dll) — so the sound comes out of the process that draws and drives the wire. Called once,
 * at activation, before the driver's first call; the addon's device is then never opened.
 */
export function useEngineAudio(relay: { call(op: string, args: unknown[], answer: boolean): Promise<unknown> | void }): void {
  const ask = <T>(op: string, args: unknown[]): Promise<T> => relay.call(op, args, true) as Promise<T>;
  const tell = (op: string, args: unknown[]): void => { relay.call(op, args, false); };
  native = {
    juceVersion: () => 'in the native engine',
    configure: (cfg) => ask<OpenedCfg>('configure', [cfg]),
    getDevices: () => ask<DeviceEntry[]>('getDevices', []),
    loadClip: (id, path) => ask<ClipMeta>('loadClip', [id, path]),
    unloadClip: (id) => tell('unloadClip', [id]),
    playClip: (id, seekSec, gain) => tell('playClip', [id, seekSec, gain]),
    stopClip: (id) => tell('stopClip', [id]),
    lockClip: (id, lock) => tell('lockClip', [id, lock]),
    setClipGain: (id, gain) => tell('setClipGain', [id, gain]),
    setClipSpatial: (id, x, y, z, omni) => tell('setClipSpatial', [id, x, y, z, omni === true]),
    clearClipSpatial: (id) => tell('clearClipSpatial', [id]),
    setClipEffects: (id, effects) => tell('setClipEffects', [id, effects]),
    setMasterEffects: (effects) => tell('setMasterEffects', [effects]),
    setMasterGain: (gain) => tell('setMasterGain', [gain]),
    setTestTone: (ch, gain) => tell('setTestTone', [ch, gain]),
    stopAll: () => tell('stopAll', []),
    getMeters: () => ask<Meters>('getMeters', []),
    getSpectrum: () => ask<number[]>('getSpectrum', []).then((a) => Float32Array.from(a ?? [])),
    close: () => tell('close', []),
    // A bake renders offline on the SAME engine — the clips it plays are loaded there. Samples travel as base64
    // of the raw float32s (interleaved), exact where a decimal rendering would not be.
    offlineBegin: (cfg) => ask<{ ok: boolean; error?: string }>('offlineBegin', [cfg]),
    offlinePull: (frames) => ask<string>('offlinePull', [frames]).then((b64) => {
      const b = Buffer.from(b64 ?? '', 'base64');
      return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }),
    offlineEnd: () => ask<void>('offlineEnd', []),
  };
  available = true;
  inEngine = true;
  console.log('[audio] playing through the native engine (E3m)');
}

// Thin, null-safe wrappers. Every call is a no-op (sensible default) when the engine is absent.
const NO_DEVICE: OpenedCfg = { deviceName: '', deviceType: '', sampleRate: 0, bufferSize: 0, channels: 0 };
export function configure(cfg: DeviceCfg): Promise<OpenedCfg> { return native ? settle(() => native.configure(cfg)) : Promise.resolve(NO_DEVICE); }
export function getDevices(): Promise<DeviceEntry[]> { return native ? settle(() => native.getDevices()) : Promise.resolve([]); }

// ---- NON-REALTIME RENDERING ----------------------------------------------------------------------
// Detaches the device, prepares the graph at an arbitrary rate, and lets the caller pull blocks as fast
// as the disk allows. Three calls rather than one render(): the driver evaluates automation, fades and
// recalls BETWEEN blocks, exactly as it does per frame live. A one-shot bounce would have to own the
// show's timeline, which belongs in the renderer.
//
// `offlinePull` hands back INTERLEAVED frames (frames * channels) — what an AudioEncoder and every WAV
// writer want. An engine built before this existed simply has no such export, which is why each is
// optional on the binding and answers a harmless nothing when absent.
export function offlineBegin(cfg: { sampleRate: number; blockSize: number; channels: number }): Promise<{ ok: boolean; error?: string }> {
  const n = native;
  if (!n?.offlineBegin) return Promise.resolve({ ok: false, error: 'this audio engine build has no offline render' });
  return settle(() => n.offlineBegin!(cfg));
}
export function offlinePull(frames: number): Promise<Float32Array> {
  const n = native;
  return n?.offlinePull ? settle(() => n.offlinePull!(frames)) : Promise.resolve(new Float32Array(0));
}
export function offlineEnd(): Promise<void> { const n = native; return n?.offlineEnd ? settle(() => n.offlineEnd!()) : Promise.resolve(); }
export function loadClip(id: string, path: string): Promise<ClipMeta | null> { const n = native; return n ? settle(() => n.loadClip(id, path)) : Promise.resolve(null); }
export function unloadClip(id: string): void { native?.unloadClip(id); }
export function playClip(id: string, seekSec: number, gain: number): void { native?.playClip(id, seekSec, gain); }
export function stopClip(id: string): void { native?.stopClip(id); }
/**
 * E3p — WHAT A SOUNDING CLIP IS HELD TO: the show clock (a bed) or the scene clock (the bound timeline's audio, a
 * video's soundtrack), and the clip's place on it — the source should read `inPoint + (clock − start)` while the clock
 * is inside `[start, start + duration)`. The native engine re-seeks the clip to its OWN clock from this (audio.rs
 * `hold`); the addon has no such clock and ignores it.
 */
export interface ClipLock {
  clock: 'show' | 'scene'; start: number; inPoint: number; duration: number;
  /** E3q: may it sound (mute / solo / loaded) — the engine starts it only if so. Absent: true. */
  audible?: boolean;
  /** E3q: the ENGINE starts and stops it (the driver only describes); false/absent: the driver plays it (E3p). */
  decide?: boolean;
}
let inEngine = false;
/** E3q: the sound plays in the native engine, so the engine decides the plays (the driver describes them). */
export function playsInEngine(): boolean { return inEngine; }
export function lockClip(id: string, lock: ClipLock | null): void { native?.lockClip?.(id, lock); }
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
export function getMeters(): Promise<Meters> {
  const n = native;
  return n
    ? settle(() => n.getMeters())
    // ⚠ `deviceLive: true` WITH NO ADDON AT ALL, AND THAT IS DELIBERATE. There is obviously no device here —
    // but "the addon did not load" is a DIFFERENT failure with its OWN badge (`no audio engine`, and a
    // startup modal). Reporting `false` too would light BOTH, telling the operator two things are broken
    // when one is, and pointing them at a USB cable when the actual problem is a missing build. Each badge
    // answers exactly one question. See Meters.deviceLive.
    : Promise.resolve({ peak: 0, rms: 0, peakL: 0, peakR: 0, peaks: [], speakers: 0, masterFxChannels: 0, deviceChannels: 0, clipped: false, deviceLive: true });
}
/**
  * The mixed output as 16 log-spaced bands, 0..1 each. Empty when there is no engine.
  *
  * A SEPARATE CALL FROM getMeters, because it is polled at a different rate: meters are a ~10 Hz
  * readout for a human eye, while a visual reacting to sound wants one per rendered frame. Bundling
  * them would force one of the two to be wrong.
  */
export function getSpectrum(): Promise<Float32Array> { const n = native; return n?.getSpectrum ? settle(() => n.getSpectrum!()) : Promise.resolve(EMPTY_SPECTRUM); }
const EMPTY_SPECTRUM = new Float32Array(16);

export function close(): void { native?.close(); }
