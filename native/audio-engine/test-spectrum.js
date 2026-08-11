// Spectrum analyser test. Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-spectrum.js
//
// THE POINT IS CORRECTNESS, NOT RESPONSIVENESS. Anything that moves when music plays looks like it
// works; an analyser is only useful if a known tone lands in the band that tone belongs to. So this
// feeds synthesised sines through `analyseSamples` — the same window, scaling and band layout the live
// audio tap uses — and asserts WHERE the energy shows up, plus how loud it reads.
//
// Synthesised rather than played, because this machine has no audio device (the meters read 0 too), so
// a tone test through the live path would "pass" by being uniformly silent. Offline is the only way to
// get a real answer here, and it is the same code either way.
const fs = require('node:fs');
const path = require('node:path');

const p = [
  path.join(__dirname, 'build', 'Release', 'audio_engine.node'),
  path.join(__dirname, 'build', 'audio_engine.node'),
].find(fs.existsSync);
if (!p) { console.error('no .node'); process.exit(2); }

const a = require(p);
const SR = 48000, N = 16, LO = 40, HI = 16000;
const edge = (b) => LO * Math.exp((Math.log(HI / LO) / N) * b);
const bandOf = (hz) => Math.floor(Math.log(hz / LO) / (Math.log(HI / LO) / N));
const label = (b) => `${edge(b).toFixed(0)}–${edge(b + 1).toFixed(0)} Hz`;

function sine(hz, amp = 1.0, n = 4096) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return buf;
}

const show = (bands) => Array.from(bands, (v) => v.toFixed(2)).join(' ');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${msg}`); };

console.log('juce:', a.juceVersion(), '\n');

// ── 1 · a tone lands in its own band ─────────────────────────────────────────────────────────────
for (const hz of [100, 440, 1000, 8000]) {
  const bands = a.analyseSamples(sine(hz), SR);
  const peak = bands.indexOf(Math.max(...bands));
  const want = bandOf(hz);
  console.log(`${hz} Hz`);
  console.log('  ', show(bands));
  check(Math.abs(peak - want) <= 1, `peaks in band ${peak} (${label(peak)}), expected ${want} (${label(want)})`);
}

// ── 2 · full scale reads as full scale ───────────────────────────────────────────────────────────
// This is what the 4/kSize correction buys. Without it the number is "some value that moves"; with it
// a 0 dBFS sine reads 1.0 and a -20 dB one reads two thirds of the way up a -60 dB scale.
console.log('\nlevel');
const full = a.analyseSamples(sine(1000, 1.0), SR);
const quiet = a.analyseSamples(sine(1000, 0.1), SR); // -20 dBFS
const b1k = bandOf(1000);
check(full[b1k] > 0.97, `0 dBFS sine reads ${full[b1k].toFixed(3)} (want ~1.00)`);
check(Math.abs(quiet[b1k] - 2 / 3) < 0.05, `-20 dBFS sine reads ${quiet[b1k].toFixed(3)} (want ~0.667 on a -60 dB scale)`);

// ── 3 · silence is silent, and neighbours are not lit ────────────────────────────────────────────
console.log('\nrejection');
const silent = a.analyseSamples(new Float32Array(4096), SR);
check(Math.max(...silent) === 0, `silence reads ${Math.max(...silent).toFixed(3)} across all bands`);
const b8k = bandOf(8000);
const t8k = a.analyseSamples(sine(8000), SR);
check(t8k[2] < 0.05, `an 8 kHz tone leaves band 2 (85–123 Hz) at ${t8k[2].toFixed(3)}`);
check(t8k[b8k] > 0.9, `and its own band at ${t8k[b8k].toFixed(3)}`);

// ── 4 · the sample rate is honoured, not assumed ─────────────────────────────────────────────────
// A hardcoded 48k would put every band in the wrong place on a 44.1k device — the failure that looks
// like "the analyser is a bit off" rather than like a bug.
console.log('\nsample rate');
const at441 = a.analyseSamples(sine(1000 * (44100 / SR)), 44100);
check(Math.abs(at441.indexOf(Math.max(...at441)) - b1k) <= 1, `a tone scaled to 44.1 kHz still peaks in band ${at441.indexOf(Math.max(...at441))}`);

console.log(`\n${failures === 0 ? 'SPECTRUM OK' : `SPECTRUM WRONG — ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
