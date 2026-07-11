// Loads the built .node and exercises it. Run under Electron's ABI via:
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-load.js
// (run-as-node executes Electron's node with Electron's V8/N-API ABI, no window).
const fs = require('node:fs');
const path = require('node:path');

const candidates = [
  path.join(__dirname, 'build', 'Release', 'audio_engine.node'),
  path.join(__dirname, 'build', 'audio_engine.node'),
];
const p = candidates.find((c) => fs.existsSync(c));
if (!p) { console.error('FAIL: no .node built'); process.exit(2); }

let addon;
try {
  addon = require(p);
} catch (e) {
  console.error('FAIL: load threw:', e && e.message);
  process.exit(3);
}

console.log('loaded     :', path.relative(__dirname, p));
console.log('electron   :', process.versions.electron || '(not electron)');
console.log('node ABI   :', process.versions.modules);
console.log('hello()    :', addon.hello());
console.log('add(2,3)   :', addon.add(2, 3));

if (addon.hello() !== 'audio-engine spike ok' || addon.add(2, 3) !== 5) {
  console.error('FAIL: unexpected basic return values');
  process.exit(4);
}

// JUCE layer
if (typeof addon.juceVersion === 'function') {
  console.log('juce ver   :', addon.juceVersion());
  try {
    console.log('deviceTypes:', addon.deviceTypeCount());
  } catch (e) {
    console.error('WARN: deviceTypeCount threw:', e && e.message);
  }
  console.log('P0b OK');
} else {
  console.log('P0a OK (no JUCE yet)');
}
