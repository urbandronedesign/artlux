// P0c sine-tone test. Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-tone.js
// Plays a 440 Hz tone for ~2.5s out of the default device, then stops. Listen for it.
const fs = require('node:fs');
const path = require('node:path');
const p = [
  path.join(__dirname, 'build', 'Release', 'audio_engine.node'),
  path.join(__dirname, 'build', 'audio_engine.node'),
].find(fs.existsSync);
if (!p) { console.error('no .node'); process.exit(2); }
const a = require(p);
console.log('juce       :', a.juceVersion());
const dev = a.startTone(440);
console.log('device     :', dev, '— playing 440Hz for 2.5s…');
setTimeout(() => { a.stopTone(); a.close(); console.log('stopped. P0c-tone done.'); process.exit(0); }, 2500);
