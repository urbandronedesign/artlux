// P0c file-playback test. Run under Electron's ABI:
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-file.js
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
const len = a.playFile(wav);
console.log('playing test.wav —', len.toFixed(2), 's (a G4→C5 arpeggio)…');
setTimeout(() => { a.close(); console.log('done. P0c-file done.'); process.exit(0); }, (len + 0.4) * 1000);
