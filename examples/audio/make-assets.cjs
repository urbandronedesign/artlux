#!/usr/bin/env node
// Synthesizes the demo sounds for the AUDIO example set.
//
//     node examples/audio/make-assets.cjs
//
// The .wav files it writes ARE COMMITTED to the repo — you do not need to run this to use the examples.
// It is here so you can see exactly what the sounds are, regenerate them, or (much more usefully) read it
// as a worked example of what each chapter needs from its audio and swap in your own.
//
// ── WHY THESE SOUNDS AND NOT MUSIC ────────────────────────────────────────────────────────────────────
// Every asset here is DESIGNED TO MAKE A LESSON AUDIBLE, which a piece of music is not.
//
//   bed-count.wav   THE BED, and it COUNTS. One beep per second, with a higher beep every 5 and a higher
//                   one still every 10. The single most important claim in this whole subsystem is "the bed
//                   does NOT restart when you recall a scene" — and with music you have to squint at a
//                   readout to believe it. With a count you simply hear it: you are on beep 23, you fire a
//                   GO, and the next thing you hear is beep 24. There is nothing to interpret.
//                   Under the beeps runs a quiet continuous DRONE, because chapters 4 and 5 automate the
//                   master gain and put a reverb on things, and you cannot hear a smooth fade — or a reverb
//                   tail — on a sound that is mostly silence.
//
//   orbit.wav       THE SPATIAL SOURCE. Harmonically rich and continuous, because an HRTF localises using
//                   interaural TIME differences at low frequencies and interaural LEVEL differences plus
//                   pinna filtering ABOVE ~2 kHz. A pure sine gives the ear almost nothing to work with and
//                   the orbit is unconvincing; broadband content makes it obvious.
//
//   sting-*.wav     PER-SCENE AUDIO. Three short, unmistakably different hits, each with a fast attack —
//                   the attack is the point, because chapter 3's whole subject is that a scene's own audio
//                   RESTARTS on every recall while the bed does not, and an attack transient is what makes
//                   a restart audible.
//
// ── FORMAT ────────────────────────────────────────────────────────────────────────────────────────────
// 44.1 kHz, 16-bit, MONO, uncompressed WAV. The engine reads wav/aiff/flac/ogg (projectFolder.ts), but
// there is no encoder in this repo's toolchain, so WAV it is. Mono because every one of these is a SOURCE:
// the ambisonic encoder needs each source's signal on its own (a spatial clip's chain is mono by
// construction — see engine.cpp), and the bed is summed to the decode anyway. Stereo would double the size
// and buy nothing.

const fs = require('node:fs');
const path = require('node:path');

const SR = 44100;
const OUT = path.join(__dirname, 'assets', 'audio');

// ── WAV ───────────────────────────────────────────────────────────────────────────────────────────────
function writeWav(file, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);        // PCM chunk size
  buf.writeUInt16LE(1, 20);         // format = PCM
  buf.writeUInt16LE(1, 22);         // channels = mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);    // byte rate
  buf.writeUInt16LE(2, 32);         // block align
  buf.writeUInt16LE(16, 34);        // bits
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // Hard-clip before quantising. A sample that wraps around int16 is not a loud sample, it is a
    // full-scale square-wave transient — the loudest and ugliest thing this file could contain.
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  const secs = (n / SR).toFixed(1);
  const kb = Math.round(buf.length / 1024);
  console.log(`  ${path.basename(file).padEnd(20)} ${secs.padStart(5)} s   ${String(kb).padStart(5)} KB`);
}

const seconds = (s) => new Float64Array(Math.round(s * SR));

// A short raised-cosine ramp at each end. EVERY sound here gets one, and it is not politeness: a waveform
// that starts or stops at a non-zero sample value is a step discontinuity, which is broadband — i.e. a
// CLICK. (The same physics as the bug fixed in engine.cpp this week; hearing it out of your own demo assets
// while learning to diagnose it in the engine would be a cruel joke.)
function declick(buf, ms = 5) {
  const k = Math.min(Math.floor((ms / 1000) * SR), Math.floor(buf.length / 2));
  for (let i = 0; i < k; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / k);
    buf[i] *= g;
    buf[buf.length - 1 - i] *= g;
  }
  return buf;
}

// Add a decaying partial. `decay` is the time constant in seconds.
function partial(buf, atSec, freq, amp, decay, dur) {
  const i0 = Math.round(atSec * SR);
  const n = Math.round(dur * SR);
  const w = (2 * Math.PI * freq) / SR;
  for (let i = 0; i < n; i++) {
    const j = i0 + i;
    if (j < 0 || j >= buf.length) continue;
    buf[j] += amp * Math.exp(-i / (decay * SR)) * Math.sin(w * i);
  }
}

// ── 1. THE BED — it counts, and it drones ─────────────────────────────────────────────────────────────
// 36 s. Long enough to fire four or five GOs and still have bed left, and to run a 20 s automation ramp
// over. (It is also 3.2 MB, and every second costs 88 KB — that is the whole reason it is not 5 minutes.)
function bed() {
  const DUR = 36;
  const buf = seconds(DUR);

  // The drone: a quiet, slightly-detuned low dyad. Continuous, so a gain ramp and a reverb tail have
  // something to act on between the beeps. Deliberately dull and low — it must never mask the count.
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    const swell = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.07 * t);   // a slow breath, so it is not a test tone
    buf[i] += 0.055 * swell * Math.sin(2 * Math.PI * 110 * t);      // A2
    buf[i] += 0.040 * swell * Math.sin(2 * Math.PI * 164.8 * t);    // E3 — a fifth
    buf[i] += 0.018 * swell * Math.sin(2 * Math.PI * 220.4 * t);    // A3, detuned 0.4 Hz ⇒ a slow beat
  }

  // The count. Beep N lands exactly at t = N seconds, so the beep you hear IS the show clock, to the
  // second. Chapter 2 asks you to read `♪ BED` and check it against what you are hearing; this is what
  // makes that check possible.
  for (let n = 1; n < DUR; n++) {
    const decade = n % 10 === 0;      // 10, 20, 30 — an octave up, and longer
    const five = !decade && n % 5 === 0;  // 5, 15, 25 — a fifth up
    const f = decade ? 1760 : five ? 1320 : 880;
    const amp = decade ? 0.42 : five ? 0.34 : 0.28;
    const dur = decade ? 0.30 : 0.14;
    partial(buf, n, f, amp, dur * 0.55, dur);
    partial(buf, n, f * 2, amp * 0.18, dur * 0.30, dur);   // a touch of second harmonic — it cuts through
  }
  writeWav(path.join(OUT, 'bed-count.wav'), declick(buf, 20));
}

// ── 2. THE SPATIAL SOURCE ─────────────────────────────────────────────────────────────────────────────
// 8 s, continuous, harmonically rich. Chapter 5 puts this on the positioner pad and orbits it around your
// head; the ear needs energy across the spectrum to localise it (see the note at the top of this file).
function orbit() {
  const buf = seconds(8);
  for (let i = 0; i < buf.length; i++) {
    const t = i / SR;
    // A pulsing sawtooth-ish stack — bright enough for the pinna cues, pitched enough not to be noise.
    const pulse = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * t);   // 2.5 Hz — you can track it as it moves
    let v = 0;
    for (let h = 1; h <= 9; h += 2) v += (1 / h) * Math.sin(2 * Math.PI * 330 * h * t);
    buf[i] = 0.30 * (0.35 + 0.65 * pulse) * v;
  }
  writeWav(path.join(OUT, 'orbit.wav'), declick(buf, 15));
}

// ── 3. THE THREE STINGS — a scene's OWN audio ─────────────────────────────────────────────────────────
// Short, hard attacks, unmistakably different from each other. The attack is the lesson: chapter 3 is about
// a scene's audio RESTARTING on every recall (while the bed does not), and a transient is what makes a
// restart something you HEAR rather than something you read.
function stings() {
  // Foyer — a soft, warm mallet. Welcoming, low, slow decay.
  {
    const b = seconds(1.6);
    for (const [f, a, d] of [[196, 0.50, 0.55], [392, 0.22, 0.35], [587, 0.10, 0.18], [784, 0.05, 0.10]])
      partial(b, 0, f, a, d, 1.6);
    writeWav(path.join(OUT, 'sting-foyer.wav'), declick(b, 3));
  }
  // Main — a bright, hard bell. The "we are on" cue.
  {
    const b = seconds(1.6);
    for (const [f, a, d] of [[880, 0.44, 0.40], [1320, 0.26, 0.28], [1976, 0.16, 0.16], [2640, 0.08, 0.09]])
      partial(b, 0, f, a, d, 1.6);
    writeWav(path.join(OUT, 'sting-main.wav'), declick(b, 2));
  }
  // Exit — a falling two-note gesture. Unmistakably "closing".
  {
    const b = seconds(1.6);
    for (const [f, a, d] of [[523, 0.42, 0.22], [784, 0.18, 0.14]]) partial(b, 0, f, a, d, 0.5);
    for (const [f, a, d] of [[330, 0.44, 0.50], [494, 0.16, 0.30]]) partial(b, 0.28, f, a, d, 1.3);
    writeWav(path.join(OUT, 'sting-exit.wav'), declick(b, 3));
  }
}

console.log('\nSynthesizing the audio example set (44.1 kHz · 16-bit · mono):\n');
bed();
orbit();
stings();
const total = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`\n  ${(total / 1048576).toFixed(2)} MB total  →  ${path.relative(process.cwd(), OUT)}\n`);
