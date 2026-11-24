#!/usr/bin/env node
// E3 — JUCE IN THE ENGINE PROCESS (plans/native-engine.md §4: "the engine clock and the audio clock become one
// clock").
//
//   node scripts/test-engine-audio.cjs [--engine <artlux-engine.exe>] [--seconds N]
//
// The app's audio engine (native/audio-engine, JUCE 8 + libspatialaudio) is now ALSO built as a C library
// (artlux_audio, src/capi.cpp — the same core.h the N-API addon compiles) that the native engine loads at run time
// (engine/artlux-engine/src/audio.rs). `--audio-selftest` loads it, opens the DEFAULT OUTPUT, plays the repo's
// 100 Hz test tone QUIETLY (master gain 0.02) and reads the AUDIO CLOCK — the samples the library has handed the
// device — against the wall for N seconds. Gates: the library loads from next to the engine (as packaged) or the
// repo, a device opens, the tone reaches the output meter, the clock advances by rate × seconds, and its drift from
// the wall is the size of a crystal's (|drift| < 500 ppm), not a missing or doubled buffer.
//
// It makes a faint sound on the default output for N seconds (default 10).
const { spawnSync } = require('node:child_process');
const path = require('node:path'); const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const ek = process.argv.indexOf('--engine');
const ENGINE = ek > 0 ? path.resolve(process.argv[ek + 1]) : path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const sk = process.argv.indexOf('--seconds');
const SECONDS = sk > 0 ? Number(process.argv[sk + 1]) : 10;
if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} (npm run build:engine)`); process.exit(2); }

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const r = spawnSync(ENGINE, ['--audio-selftest', '--seconds', String(SECONDS), '--gain', '0.02', '--clip', path.join(ROOT, 'native', 'audio-engine', 'tone-100.wav')], { env, encoding: 'utf8', timeout: (SECONDS + 40) * 1000 });
const out = r.stdout ?? '';
const j = (() => { try { return JSON.parse(out.slice(out.indexOf('{'))); } catch { return null; } })();
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failed++; };
if (!j) {
  console.log((r.stderr ?? '').trim());
  check('the engine ran JUCE', false, `exit ${r.status}`);
} else {
  check('the audio library loaded', !!j.library, j.library);
  check('JUCE answers', /^JUCE v8/.test(j.juce), j.juce);
  check('an output device opened', j.device && j.device.sampleRate > 0, `${j.device?.deviceName} (${j.device?.deviceType}), ${j.device?.sampleRate} Hz, ${j.device?.bufferSize} samples, ${j.device?.channels} ch`);
  check('the test tone reached the output meter', j.peak > 0.001, `peak ${j.peak.toFixed(4)}`);
  const expected = j.rate * j.seconds;
  check('the audio clock advanced by rate × seconds', Math.abs(j.samples - expected) < j.rate * 0.1, `${j.samples} samples in ${j.seconds} s (${expected} expected)`);
  check('the audio clock runs at a crystal\'s rate against the wall', Math.abs(j.driftPpm) < 500, `${j.driftPpm.toFixed(1)} ppm over ${j.readings} readings — ${(j.driftPpm * 3.6).toFixed(1)} ms an hour`);
}
console.log(failed ? `\nengine audio: ${failed} FAILED` : '\nengine audio OK');
process.exit(failed ? 1 : 0);
