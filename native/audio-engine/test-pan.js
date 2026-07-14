// P2b verification — a spatialised clip must actually land on the correct SIDE.
// Plays test.wav twice through the ambisonic bus: once placed hard LEFT (x=-1), once hard RIGHT (x=+1),
// and compares the per-channel output peaks. Binaural HRTF never fully isolates an ear (both get signal,
// with ITD/ILD), but the near ear must clearly dominate. A flipped azimuth shows up here instantly.
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-pan.js
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
console.log('device :', a.configure(2));
console.log('loaded :', a.loadClip('c1', wav));

// Measure peak L/R while the clip plays at a given position.
function measure(label, x, y, z) {
  return new Promise((resolve) => {
    a.setClipSpatial('c1', x, y, z);
    a.playClip('c1', 0, 0.9);
    let pL = 0, pR = 0;
    const iv = setInterval(() => {
      const m = a.getMeters();
      if (m.peakL > pL) pL = m.peakL;
      if (m.peakR > pR) pR = m.peakR;
    }, 20);
    setTimeout(() => {
      clearInterval(iv);
      a.stopClip('c1');
      console.log(`${label.padEnd(18)} peakL=${pL.toFixed(4)}  peakR=${pR.toFixed(4)}  ratio L/R=${(pL / Math.max(pR, 1e-6)).toFixed(2)}`);
      setTimeout(() => resolve({ pL, pR }), 250); // let the HRTF tail drain
    }, 1200);
  });
}

(async () => {
  const left = await measure('hard LEFT (x=-1)', -1, 0, 0);
  const right = await measure('hard RIGHT (x=+1)', 1, 0, 0);
  a.close();

  const leftOk = left.pL > left.pR * 1.1;
  const rightOk = right.pR > right.pL * 1.1;
  console.log('');
  if (leftOk && rightOk) {
    console.log('P2b OK — spatialisation works and the sides are correct (left source → L dominant, right source → R dominant)');
    process.exit(0);
  }
  if (left.pR > left.pL * 1.1 && right.pL > right.pR * 1.1) {
    console.log('P2b FAIL — sides are INVERTED: the azimuth sign is wrong (check atan2(-x, z))');
  } else {
    console.log(`P2b FAIL — no clear panning (leftOk=${leftOk} rightOk=${rightOk})`);
  }
  process.exit(1);
})();
