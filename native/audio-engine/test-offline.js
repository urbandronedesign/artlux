// OFFLINE RENDER OF THE AUDIO GRAPH -- no device, no UI, no app.
//
//   npm run test:audio-offline
//
// The three properties a non-realtime render depends on, and none of them is observable from the live
// path: that the graph runs at all with no AudioDeviceManager (it is a plain juce::AudioSource, but
// nothing proved it until this existed), that a playing clip actually reaches the output, and that TWO
// RENDERS OF THE SAME RANGE ARE BYTE-IDENTICAL. The last one is the whole feature: clips are normally
// built with a read-ahead thread whose BufferingAudioSource returns SILENCE on underrun rather than
// blocking -- correct for a show, and for a render it would pepper the output with gaps that differ
// every run. Offline builds them with readAheadSize 0 and no thread instead, and this is what says so.
//
// Runs under Electron as Node because the addon is built against Electron ABI.
const path = require('path');
const REPO = process.argv[2];
const eng = require(path.join(REPO, 'native/audio-engine/audio_engine.node'));
const wav = path.join(REPO, 'native/audio-engine/tone-100.wav');

let fails = 0;
const ok = (n, c, extra = '') => { console.log((c ? '  ok   ' : '  FAIL ') + n + (extra ? ' - ' + extra : '')); if (!c) fails++; };

ok('addon exports the offline trio',
  typeof eng.offlineBegin === 'function' && typeof eng.offlinePull === 'function' && typeof eng.offlineEnd === 'function');

const SR = 48000, CH = 2, BLOCK = 512;
const began = eng.offlineBegin({ sampleRate: SR, blockSize: BLOCK, channels: CH });
ok('offlineBegin succeeds with NO audio device', began && began.ok === true, JSON.stringify(began));

ok('offlineBegin refuses to start twice', eng.offlineBegin({ sampleRate: SR, blockSize: BLOCK, channels: CH }).ok === false);

// Silence first: a graph with nothing loaded must render zeros, not garbage.
const quiet = eng.offlinePull(SR / 10);
ok('pull returns interleaved frames', quiet.length === (SR / 10) * CH, quiet.length + ' floats');
ok('an empty graph renders silence', quiet.every((v) => v === 0));

// Now load a tone and play it: the render must actually contain signal.
eng.loadClip('t', wav);
eng.playClip('t', 0, 1);
const pcm = eng.offlinePull(SR / 2);            // half a second
let peak = 0, nonzero = 0;
for (const v of pcm) { const a = Math.abs(v); if (a > peak) peak = a; if (a > 1e-4) nonzero++; }
ok('a playing clip renders audible signal', peak > 0.01, 'peak ' + peak.toFixed(4));
ok('most of the block is non-silent', nonzero > pcm.length * 0.5, nonzero + '/' + pcm.length);

// Determinism: the whole point. Same range, twice, byte-identical.
eng.offlineEnd();
eng.offlineBegin({ sampleRate: SR, blockSize: BLOCK, channels: CH });
eng.playClip('t', 0, 1);
const a2 = eng.offlinePull(SR / 2);
eng.offlineEnd();
eng.offlineBegin({ sampleRate: SR, blockSize: BLOCK, channels: CH });
eng.playClip('t', 0, 1);
const b2 = eng.offlinePull(SR / 2);
let diff = 0;
for (let i = 0; i < a2.length; i++) if (a2[i] !== b2[i]) diff++;
ok('two renders of the same range are IDENTICAL', diff === 0, diff + ' differing samples');

eng.offlineEnd();
ok('pull after end returns nothing', eng.offlinePull(128).length === 0);

console.log(fails ? '\n' + fails + ' FAILED\n' : '\nall passed\n');
process.exit(fails ? 1 : 0);
