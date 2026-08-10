// Sound, as sixteen numbers a shader can read.
//
// ── THE SEAM ─────────────────────────────────────────────────────────────────────────────────────
// The analyser lives in the JUCE engine, which belongs to @artlux/plugin-audio, and this is
// @artlux/plugin-shader. There is no SDK service for one plugin to read another's data, so the two
// meet at an IPC CHANNEL NAME — a string, not an import. That matters: importing the audio plugin here
// would give the bundler two module identities for its native handle, which is the duplicate-singleton
// bug the barrel rule exists to prevent. A channel name couples nothing.
//
// (The proper fix is a host service — `host.audio.spectrum()` — so this is written behind one function
// that a service would replace without touching a shader.)
//
// ── THE ENVELOPE ─────────────────────────────────────────────────────────────────────────────────
// Raw band values are jittery: a band jumps to full on a transient and back to nothing on the next
// frame, and a visual driven by that flickers rather than pulses. So each band gets an asymmetric
// envelope — fast up, slow down — which is what a level meter, a compressor and every VU needle do,
// and the reason music software feels like it is "reacting" rather than twitching.

import type { PluginIpc } from '@artlux/sdk/renderer';
import { BeatDetector, CHANNEL_COUNT, setBeatFall, DEFAULT_BEAT_FALL_SEC } from './beatDetect';
export { DEFAULT_BEAT_FALL_SEC };

export const BAND_COUNT = 16;

/**
 * THE ENVELOPE, IN SECONDS RATHER THAN PER-FRAME COEFFICIENTS.
 *
 * The first version smoothed by a fixed fraction each frame, which means the same setting behaves
 * differently at 30 and 60 fps and reacts differently on a busy frame than a quiet one — the smoothing
 * would quietly change whenever the rest of the show got heavier. Time constants do not care how often
 * they are sampled, and they are also the only way a damper expressed in seconds can be honest.
 */
const ATTACK_SEC = 0.02;                 // rise: near-instant, so a hit is not softened
export const DEFAULT_BAND_FALL_SEC = 0.25;
let bandFallSec = DEFAULT_BAND_FALL_SEC;

/** The dampers. Both are fall TIMES in seconds — bigger is smoother and slower to let go. */
export function setDamping(bandFall: number, beatFall: number): void {
  bandFallSec = Math.max(0.02, Math.min(4, bandFall));
  setBeatFall(beatFall);
}

let ipc: PluginIpc | null = null;
let polling = false;
const bands = new Float32Array(BAND_COUNT);   // enveloped — what shaders read
const raw = new Float32Array(BAND_COUNT);     // last value from the engine
let level = 0;
let lastT = -1;
const beats = new BeatDetector();

export function setIpc(handle: PluginIpc): void { ipc = handle; }

/**
 * Start asking the engine for spectra.
 *
 * Poll rather than subscribe, and only while something wants it: a project with no audio-reactive
 * shader should not be moving data across the process boundary sixty times a second. `stop()` is what
 * a projector window or an idle editor gets.
 */
export function start(): void {
  if (polling || !ipc) return;
  polling = true;
  const tick = async () => {
    if (!polling) return;
    try {
      const next = (await ipc!.invoke('audio:getSpectrum')) as Float32Array | number[] | undefined;
      if (next) for (let i = 0; i < BAND_COUNT; i++) raw[i] = Number(next[i]) || 0;
    } catch {
      // The audio plugin may not be there at all (no engine built, or a launch without it). Silence is
      // the honest answer and it must not be a per-frame exception in a render loop.
      raw.fill(0);
    }
    const now = performance.now() / 1000;
    const dt = lastT < 0 ? 1 / 60 : Math.max(0, Math.min(0.25, now - lastT));
    lastT = now;

    // Beats come from the RAW bands, not the enveloped ones: the envelope exists to stop a visual
    // flickering, and smoothing the signal before looking for a jump is smoothing away the jump.
    beats.update(raw, now);

    let sum = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const target = raw[i];
      // 1 - e^(-dt/tau): the fraction of the remaining distance to cover in this much time. Falls back
      // to a sensible step at any frame rate, and reaches the target rather than crawling at it.
      const k = 1 - Math.exp(-dt / (target > bands[i] ? ATTACK_SEC : bandFallSec));
      bands[i] += (target - bands[i]) * k;
      sum += bands[i];
    }
    level = sum / BAND_COUNT;
    if (polling) requestAnimationFrame(() => void tick());
  };
  void tick();
}

export function stop(): void { polling = false; }

/** Beat pulses per channel (kick, snare, mid, high) — 1 at the hit, decaying. Live array. */
export function beatPulses(): Float32Array { return beats.pulses; }
/** Beats counted per channel since start, so a shader can step on every kick. Live array. */
export function beatCounts(): Float32Array { return beats.counts; }
export { CHANNEL_COUNT as BEAT_CHANNELS };

/** The enveloped bands, for the uniform upload. Live array — read it, do not keep it. */
export function spectrum(): Float32Array { return bands; }
export function broadband(): number { return level; }
