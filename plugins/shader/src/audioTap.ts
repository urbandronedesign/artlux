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

export const BAND_COUNT = 16;

/** Rise is near-instant so a hit is not softened; fall is ~250 ms so the eye reads a pulse, not a flicker. */
const ATTACK = 0.6;
const RELEASE = 0.12;

let ipc: PluginIpc | null = null;
let polling = false;
const bands = new Float32Array(BAND_COUNT);   // enveloped — what shaders read
const raw = new Float32Array(BAND_COUNT);     // last value from the engine
let level = 0;

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
    let sum = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const target = raw[i];
      const k = target > bands[i] ? ATTACK : RELEASE;
      bands[i] += (target - bands[i]) * k;
      sum += bands[i];
    }
    level = sum / BAND_COUNT;
    if (polling) requestAnimationFrame(() => void tick());
  };
  void tick();
}

export function stop(): void { polling = false; }

/** The enveloped bands, for the uniform upload. Live array — read it, do not keep it. */
export function spectrum(): Float32Array { return bands; }
export function broadband(): number { return level; }
