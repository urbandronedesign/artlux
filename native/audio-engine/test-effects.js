// P3 verification — juce_dsp effect chains (clip inserts + master inserts).
//   node gen-tones.js
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-effects.js
//
// An effect that silently does nothing still compiles, still "plays fine", and still meters — so every
// check here MEASURES a specific, predicted number instead of eyeballing it. Two structural rules, or
// the measurements are worthless:
//
//   1. Every measured clip is NON-SPATIAL. The binaural HRTF has its own frequency response and
//      interaural gain — an 8 kHz tone through it is not 0.5 peak, so a filter measurement through it
//      would be meaningless. Never call setClipSpatial here.
//   2. Every assertion is a RATIO against a baseline measured in the SAME process, on the SAME file,
//      through the SAME open device. Absolute peaks depend on the OS mixer volume.
const fs = require('node:fs');
const path = require('node:path');

const p = [
  path.join(__dirname, 'build', 'Release', 'audio_engine.node'),
  path.join(__dirname, 'build', 'audio_engine.node'),
].find(fs.existsSync);
if (!p) { console.error('no .node — run cmake-js compile first'); process.exit(2); }
for (const w of ['tone-8k.wav', 'tone-100.wav', 'tone-loud.wav', 'burst.wav']) {
  if (!fs.existsSync(path.join(__dirname, w))) { console.error(`missing ${w} — run: node gen-tones.js`); process.exit(2); }
}
const a = require(p);
const wav = (n) => path.join(__dirname, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = 0;
// Play `file` through `effects` and report the peak inside a time window (ms from play start), plus when
// the signal first crossed a threshold (used to verify the delay's TIME, not just that something rang).
async function measure(file, effects, { from = 300, to = 1200, thresh = 0.05 } = {}) {
  const clip = `c${++id}`;
  a.loadClip(clip, wav(file));
  a.setClipEffects(clip, effects);
  const t0 = Date.now();
  a.playClip(clip, 0, 1.0);
  let peak = 0, firstAboveMs = -1;
  while (Date.now() - t0 < to) {
    const dt = Date.now() - t0;
    if (dt >= from) {
      const m = a.getMeters();
      if (m.peak > peak) peak = m.peak;
      if (firstAboveMs < 0 && m.peak > thresh) firstAboveMs = dt;
    }
    await sleep(15);
  }
  a.stopClip(clip);
  a.unloadClip(clip); // drop the chain too — a reverb/delay tail must not bleed into the next measurement
  await sleep(200);
  return { peak, firstAboveMs };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
}

(async () => {
  console.log('device    :', a.configure(2, 'binaural', 'stereo'));
  console.log('juce      :', a.juceVersion());

  // ── clip inserts ────────────────────────────────────────────────────────────────────────────
  console.log('\n[clip effect chain]');

  // gain: the canary. If this fails the chain isn't wired at all and nothing below means anything.
  const g0 = await measure('tone-loud.wav', []);
  const g1 = await measure('tone-loud.wav', [{ id: 'g', type: 'gain', params: { gainDb: -12 } }]);
  const gr = g1.peak / Math.max(g0.peak, 1e-9);
  check('gain -12 dB → 0.251x', gr > 0.20 && gr < 0.31, `base=${g0.peak.toFixed(3)} fx=${g1.peak.toFixed(3)} ratio=${gr.toFixed(3)}`);

  // bypass must actually bypass (an inverted flag is invisible any other way).
  const gb = await measure('tone-loud.wav', [{ id: 'g', type: 'gain', bypass: true, params: { gainDb: -24 } }]);
  const gbr = gb.peak / Math.max(g0.peak, 1e-9);
  check('bypass → unity', gbr > 0.9 && gbr < 1.1, `ratio=${gbr.toFixed(3)}`);

  // lowpass an 8 kHz tone at 200 Hz: 2-pole over ~5.3 octaves ⇒ ≈ −64 dB. Must collapse.
  const l0 = await measure('tone-8k.wav', []);
  const l1 = await measure('tone-8k.wav', [{ id: 'f', type: 'filter', opts: { mode: 'lowpass' }, params: { cutoff: 200, resonance: 0.707 } }]);
  const lr = l1.peak / Math.max(l0.peak, 1e-9);
  check('lowpass 200Hz kills 8kHz', lr < 0.05, `base=${l0.peak.toFixed(3)} fx=${l1.peak.toFixed(4)} ratio=${lr.toFixed(4)}`);

  // highpass a 100 Hz tone at 5 kHz. Also the only proof that opts.mode is plumbed through at all.
  const h0 = await measure('tone-100.wav', []);
  const h1 = await measure('tone-100.wav', [{ id: 'f', type: 'filter', opts: { mode: 'highpass' }, params: { cutoff: 5000, resonance: 0.707 } }]);
  const hr = h1.peak / Math.max(h0.peak, 1e-9);
  check('highpass 5kHz kills 100Hz', hr < 0.05, `base=${h0.peak.toFixed(3)} fx=${h1.peak.toFixed(4)} ratio=${hr.toFixed(4)}`);

  // compressor. 0.9 = −0.92 dBFS; over threshold by 23.1 dB; GR = −23.1·(1−1/8) = −20.2 dB ⇒ ≈0.088.
  const c1 = await measure('tone-loud.wav', [{ id: 'c', type: 'compressor', params: { thresholdDb: -24, ratio: 8, attackMs: 5, releaseMs: 100, makeupDb: 0 } }]);
  const cr = c1.peak / Math.max(g0.peak, 1e-9);
  check('compressor pulls peak down', cr < 0.3 && cr > 0.01, `ratio=${cr.toFixed(3)} (predicted ≈0.10)`);

  // …and the anti-false-positive: BELOW threshold it must do nothing. Proves we measured compression,
  // not just a broken gain stage that attenuates whatever it touches.
  const c2 = await measure('tone-loud.wav', [{ id: 'c', type: 'compressor', params: { thresholdDb: 0, ratio: 8, attackMs: 5, releaseMs: 100 } }]);
  const c2r = c2.peak / Math.max(g0.peak, 1e-9);
  check('compressor under thresh = unity', c2r > 0.9 && c2r < 1.1, `ratio=${c2r.toFixed(3)}`);

  // delay + reverb: burst.wav is 0.3 s of tone then 1.2 s of SILENCE. Anything the meter sees after
  // ~450 ms came out of an effect's tail — there is nothing else it could be.
  const t0 = await measure('burst.wav', [], { from: 450, to: 1400 });
  check('burst is silent after 450ms', t0.peak < 0.01, `tail base=${t0.peak.toFixed(4)} (the control)`);

  const d1 = await measure('burst.wav', [{ id: 'd', type: 'delay', params: { timeMs: 400, feedback: 0.5, mix: 1.0 } }], { from: 350, to: 1400 });
  check('delay rings after source ends', d1.peak > 0.05, `tail peak=${d1.peak.toFixed(3)}`);
  // …and it rings at the RIGHT time. Validates timeMs itself, not merely "something happened".
  check('delay time ≈ 400ms', d1.firstAboveMs >= 340 && d1.firstAboveMs <= 560, `first audible at ${d1.firstAboveMs}ms`);

  const r1 = await measure('burst.wav', [{ id: 'r', type: 'reverb', params: { roomSize: 0.9, damping: 0.2, wet: 0.9, dry: 0.0, width: 1 } }], { from: 450, to: 1400 });
  // Reverb is the one effect whose LEVEL cannot be asserted: juce::Reverb's absolute wet gain and its
  // roomSize→RT60 mapping are undocumented. So assert presence against the silent control, not a number.
  check('reverb tail present', r1.peak > 0.01 && r1.peak > 10 * Math.max(t0.peak, 1e-4), `tail peak=${r1.peak.toFixed(4)} vs control ${t0.peak.toFixed(4)}`);

  // ── master inserts ──────────────────────────────────────────────────────────────────────────
  console.log('\n[master chain]  (non-spatial clip — this is what catches a master stage skipped by the no-spatial-clips path)');

  a.setMasterEffects([{ id: 'mg', type: 'gain', params: { gainDb: -12 } }]);
  const m1 = await measure('tone-loud.wav', []);
  const mr = m1.peak / Math.max(g0.peak, 1e-9);
  check('master gain -12 dB → 0.251x', mr > 0.20 && mr < 0.31, `ratio=${mr.toFixed(3)}`);

  // The chain must be built for the channel count the audio thread actually sees, or it passes dry.
  const mm = a.getMeters();
  check('master fx channels = device', mm.masterFxChannels === mm.deviceChannels && mm.deviceChannels > 0,
    `fx=${mm.masterFxChannels} device=${mm.deviceChannels}`);

  a.setMasterEffects([]);
  const m2 = await measure('tone-loud.wav', []);
  const m2r = m2.peak / Math.max(g0.peak, 1e-9);
  check('master chain cleared', m2r > 0.9 && m2r < 1.1, `ratio=${m2r.toFixed(3)}`);

  // Reverb on the master is DROPPED in C++ (dsp::Reverb silently passes dry above 2ch — a trap, not a
  // feature). It must be inert, and must not crash.
  a.setMasterEffects([{ id: 'mr', type: 'reverb', params: { roomSize: 0.9, wet: 1, dry: 0 } }]);
  const m3 = await measure('burst.wav', [], { from: 450, to: 1400 });
  check('master reverb refused', m3.peak < 0.01, `tail peak=${m3.peak.toFixed(4)} (must stay silent)`);
  a.setMasterEffects([]);

  // Master fader.
  a.setMasterGain(0.5);
  const m4 = await measure('tone-loud.wav', []);
  const m4r = m4.peak / Math.max(g0.peak, 1e-9);
  check('master gain 0.5 → 0.5x', m4r > 0.42 && m4r < 0.58, `ratio=${m4r.toFixed(3)}`);
  a.setMasterGain(1.0);

  a.close();
  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(`P3 OK — ${results.length}/${results.length} effect measurements passed`);
    process.exit(0);
  }
  console.log(`P3 FAIL — ${failed.length}/${results.length} failed: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
})();
