// C3a engine test. Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-engine.js
// Configures the device, loads + plays test.wav through the mixer, samples the meters, and reports
// the peak observed (proves the whole chain carried signal). You should also hear the arpeggio.
const fs = require('node:fs');
const path = require('node:path');
const p = [
  path.join(__dirname, 'build', 'Release', 'audio_engine.node'),
  path.join(__dirname, 'build', 'audio_engine.node'),
].find(fs.existsSync);
if (!p) { console.error('no .node'); process.exit(2); }
const wav = path.join(__dirname, 'test.wav');
if (!fs.existsSync(wav)) { console.error('run gen-wav.js first'); process.exit(2); }

const a = require(p);
console.log('juce    :', a.juceVersion());
console.log('device  :', a.configure(2));
const devs = a.getDevices();
console.log('outputs :', devs.length, '→', devs.slice(0, 4));
console.log('loaded  :', a.loadClip('c1', wav));
a.playClip('c1', 0, 0.8);

let peak = 0;
const iv = setInterval(() => { const m = a.getMeters(); if (m.peak > peak) peak = m.peak; }, 50);
setTimeout(() => {
  clearInterval(iv);
  a.stopClip('c1');
  a.close();
  console.log('max meter peak:', peak.toFixed(3));
  console.log(peak > 0.01 ? 'C3a OK — audio flowed through the chain' : 'C3a WARN — no signal on meters');
  process.exit(0);
}, 1800);
