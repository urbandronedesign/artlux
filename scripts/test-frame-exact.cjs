// PROVE THAT A NON-REALTIME RENDER GETS THE FRAME IT ASKED FOR.
//
//   npm run test:frame-exact
//
// WHY THIS EXISTS AS A HARNESS AND NOT A UNIT TEST. "Did the decoder return the right picture" cannot
// be answered by inspecting the decoder — every accessor in plugins/mp4 is *designed* to hand back a
// neighbour rather than stall a show, and one of them (`thumbnail()`) reads exactly like a frame-exact
// one-shot while falling back to "the earliest buffered frame so we show something". A renderer that
// trusts it writes the wrong pictures into a file and nobody notices until it is on a wall.
//
// So the harness does a ROUND TRIP with ground truth that does not come from the code under test:
//   1. encode 48 frames whose every pixel is a flat grey encoding that frame's own index,
//      through WebCodecs + mediabunny, into a real MP4 with real GOPs (keyframe every ~0.5 s);
//   2. read it back through the REAL plugins/mp4 FileDecoder;
//   3. for each frame, in FORWARD, BACKWARD and RANDOM order, ask frameExact() for it, draw what
//      comes back, and read the index out of the pixels.
//
// The backward and random passes are the point: a forward-only feed passes a sequential test and
// fails the moment a render loops, or an operator re-bakes a range. Both found real bugs the day this
// was written — a flush()-to-drain strategy that poisoned every subsequent delta frame, and an
// end-of-track case that confidently returned frame 43 for frames 44, 45 and 46.
//
// It also reports how often `thumbnail()` gets the same question wrong, which is the measurement that
// justified adding frameExact() to the SDK at all.

const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const REPO = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'frame-exact');

(async () => {
  await esbuild.build({
    entryPoints: [path.join(DIR, 'harness.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
    outfile: path.join(DIR, 'bundle.js'),
    absWorkingDir: REPO,
    nodePaths: [path.join(REPO, 'node_modules')],
    alias: {
      // The decoder reaches the host for a media URL; the page registers a blob URL instead, so the
      // harness needs no app, no custom protocol and no project.
      '@/services/mediaCache': path.join(DIR, 'stub-mediacache.ts'),
      '@plugin-mp4/mp4Decoder': path.join(REPO, 'plugins/mp4/src/mp4Decoder.ts'),
    },
    logLevel: 'warning',
  });

  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set, it would start Node and never open a renderer
  try {
    // Point Electron at the entry FILE, not the directory: given a directory it looks for a
    // package.json 'main' there, finds none, and exits 1 with no output at all.
    execFileSync(electron, [path.join(DIR, 'main.js')], { stdio: 'inherit', env });
  } catch (e) {
    process.exit(typeof e.status === 'number' ? e.status : 1);
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
