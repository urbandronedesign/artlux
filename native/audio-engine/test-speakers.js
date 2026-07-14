// P2d verification — ambisonic SPEAKER-LAYOUT decode (as opposed to binaural HRTF).
//   ELECTRON_RUN_AS_NODE=1 ../../node_modules/electron/dist/electron.exe test-speakers.js
//
// This machine's default device is stereo, so we verify in two parts:
//   1. DECODER PANS: mode=speakers, layout=stereo → a hard-left source must put energy on ch0, not ch1.
//      This exercises AmbisonicDecoder (a different code path from the binauralizer) on real hardware.
//   2. LAYOUTS CONFIGURE: quad/octagon/cube report the right speaker count. The decode maths is the same
//      code path regardless of count; only the device's channel count limits how many are actually played.
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

function play(label, x, ms = 1100) {
  return new Promise((resolve) => {
    a.setClipSpatial('c1', x, 0, 0);
    a.playClip('c1', 0, 0.9);
    const pk = [0, 0];
    const iv = setInterval(() => {
      const m = a.getMeters();
      for (let i = 0; i < 2; i++) if (m.peaks[i] > pk[i]) pk[i] = m.peaks[i];
    }, 20);
    setTimeout(() => {
      clearInterval(iv);
      a.stopClip('c1');
      console.log(`  ${label.padEnd(20)} ch0=${pk[0].toFixed(4)} ch1=${pk[1].toFixed(4)}  ratio=${(pk[0] / Math.max(pk[1], 1e-6)).toFixed(2)}`);
      setTimeout(() => resolve(pk), 250);
    }, ms);
  });
}

(async () => {
  // ── 1. Speaker decode pans correctly (stereo layout, on the real device) ─────────────────────
  console.log('device    :', a.configure(2, 'speakers', 'stereo'));
  console.log('loaded    :', a.loadClip('c1', wav));
  console.log('speakers  :', a.getMeters().speakers, '(stereo layout)');
  console.log('\n[speaker decode — layout=stereo]');
  const left = await play('source LEFT', -1);
  const right = await play('source RIGHT', 1);
  const pansOk = left[0] > left[1] * 1.1 && right[1] > right[0] * 1.1;

  // ── 2. Larger layouts configure (speaker counts) ──────────────────────────────────────────────
  console.log('\n[layout configuration]');
  const counts = {};
  for (const layout of ['quad', '5.1', '7.1', 'hexagon', 'octagon', 'cube']) {
    a.configure(2, 'speakers', layout);      // live decoder swap — no device reopen
    counts[layout] = a.getMeters().speakers;
    console.log(`  ${layout.padEnd(10)} → ${counts[layout]} speakers`);
  }
  const layoutsOk = counts.quad === 4 && counts.octagon === 8 && counts.cube === 8 && counts.hexagon === 6;

  // ── 3. Binaural still works (regression) ─────────────────────────────────────────────────────
  console.log('\n[binaural regression]');
  a.configure(2, 'binaural', 'stereo');
  const bin = await play('binaural LEFT', -1);
  const binOk = bin[0] > bin[1] * 1.1;

  a.close();
  console.log('');
  if (pansOk && layoutsOk && binOk) {
    console.log('P2d OK — speaker decode pans correctly, layouts configure (quad 4 / hex 6 / octagon 8 / cube 8), binaural unregressed');
    process.exit(0);
  }
  console.log(`P2d FAIL — pansOk=${pansOk} layoutsOk=${layoutsOk} binauralOk=${binOk}`);
  process.exit(1);
})();
