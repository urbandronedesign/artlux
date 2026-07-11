// Test signals for the P3 effect-chain verification (test-effects.js). Each one is chosen so that ONE
// effect produces an unambiguous, MEASURABLE change in the engine's peak meter — an effect that silently
// does nothing still compiles and still "plays fine", so eyeballing proves nothing.
//
//   tone-8k.wav   8 kHz sine   → a 200 Hz LOWPASS must collapse it to ~0
//   tone-100.wav  100 Hz sine  → a 5 kHz HIGHPASS must collapse it to ~0
//   tone-loud.wav 1 kHz @ 0.9  → a compressor over threshold must pull the peak well down
//   burst.wav     0.3 s of 1 kHz then 1.2 s of SILENCE → delay/reverb must produce output in the silence
//
// 16-bit stereo, 48 kHz — the format the JUCE reader path already handles.
const fs = require('node:fs');
const path = require('node:path');

const SR = 48000;

function writeWav(name, secs, sample) {
  const ch = 2;
  const n = Math.floor(SR * secs);
  const data = Buffer.alloc(n * ch * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, sample(i / SR)));
    const s = Math.round(v * 32767);
    data.writeInt16LE(s, (i * ch + 0) * 2);
    data.writeInt16LE(s, (i * ch + 1) * 2);
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(ch, 22);
  hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * ch * 2, 28); hdr.writeUInt16LE(ch * 2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  const out = path.join(__dirname, name);
  fs.writeFileSync(out, Buffer.concat([hdr, data]));
  console.log('wrote', name, `${(secs).toFixed(1)}s`);
}

// A few ms of ramp at each end keeps the file itself from clicking (a click is broadband — it would
// leak through a lowpass and muddy the measurement).
const ramp = (t, secs) => Math.min(1, t * 200) * Math.min(1, Math.max(0, secs - t) * 200);
const sine = (f, amp, secs) => (t) => Math.sin(2 * Math.PI * f * t) * amp * ramp(t, secs);

writeWav('tone-8k.wav', 3.0, sine(8000, 0.5, 3.0));
writeWav('tone-100.wav', 3.0, sine(100, 0.5, 3.0));
writeWav('tone-loud.wav', 3.0, sine(1000, 0.9, 3.0));
// Burst then silence: everything after 0.3 s that reaches the meter came from an effect's TAIL.
writeWav('burst.wav', 1.5, (t) => (t < 0.3 ? Math.sin(2 * Math.PI * 1000 * t) * 0.7 * ramp(t, 0.3) : 0));
