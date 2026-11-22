// P2a gate — libspatialaudio linked + the ambisonic chain runs inside the addon.
// Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-spatial.js
// Also re-checks the P1 engine (device open + file playback) so we know P2a didn't regress it.
const fs = require('node:fs');
const path = require('node:path');
const p = [
  path.join(__dirname, 'build', 'Release', 'audio_engine.node'),
  path.join(__dirname, 'build', 'audio_engine.node'),
].find(fs.existsSync);
if (!p) { console.error('no .node'); process.exit(2); }

const a = require(p);
console.log('juce      :', a.juceVersion());

const s = a.spatialProbe();
console.log('spatial   :', s);

const ok = s.encoder && s.bformat && s.binauralizer && s.ran && s.outPeak > 0.001;
console.log(ok
  ? `P2a OK — encode → B-format → binaural (MIT HRTF) ran; HRTF tail ${s.tailLength} samples, out peak ${s.outPeak.toFixed(4)}`
  : 'P2a FAIL — the ambisonic chain did not produce signal');

// Regression: the P1 engine must still open a device and play a file.
const wav = path.join(__dirname, 'test.wav');
if (fs.existsSync(wav)) (async () => {
  // The engine's answering calls return PROMISES (engine.cpp: the audio control thread) — awaited here.
  console.log('device    :', await a.configure({ channels: 2 }));
  console.log('loaded    :', await a.loadClip('c1', wav));
  a.playClip('c1', 0, 0.8);
  let peak = 0;
  const iv = setInterval(() => { a.getMeters().then((m) => { if (m.peak > peak) peak = m.peak; }); }, 50);
  setTimeout(() => {
    clearInterval(iv);
    a.stopClip('c1'); a.close();
    console.log('P1 regression: max meter peak', peak.toFixed(3), peak > 0.01 ? '— still plays OK' : '— NO SIGNAL');
    process.exit(ok && peak > 0.01 ? 0 : 1);
  }, 1800);
})(); else {
  process.exit(ok ? 0 : 1);
}
