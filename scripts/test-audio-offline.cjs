// Run the audio engine's offline-render smoke test.
//
//   npm run test:audio-offline
//
// The test itself is native/audio-engine/test-offline.js, beside the other addon tests (test-engine,
// test-spatial, test-speakers), because it is about the addon and not about the app.
//
// It must run under Electron-as-Node: the addon is built against Electron's ABI, so plain `node`
// cannot load it. Needs no audio device and opens no window — which is the point of the thing it
// tests, and is why this is runnable on a machine (or a CI box) with no sound card at all.

const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
const test = path.join(REPO, 'native', 'audio-engine', 'test-offline.js');

try {
  execFileSync(electron, [test, REPO], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
} catch (e) {
  process.exit(typeof e.status === 'number' ? e.status : 1);
}
