// PROVE THAT HAP ANSWERS AN EXACT FRAME, AND SAY WHAT ITS ALPHA ACTUALLY DOES.
//
//   npm run test:hap-exact -- "C:\path\to\clip.mov"
//   ARTLUX_HAP="C:\path\to\clip.mov" npm run test:hap-exact
//
// HAP is the most show-critical codec in the app, and it is the one codec whose bake path had never
// been run against real material — test:frame-exact covers mp4 only, because it can MAKE an mp4 and
// cannot make a HAP file. So this takes one from the operator instead.
//
// It asks three things the app cannot answer on its own:
//
//   1. Is frameExact ORDER-INDEPENDENT? Index N must give the same bytes whether it was reached going
//      forward or coming back. This is the exact property the mp4 decoder did not have, where a
//      backward pass silently returned a neighbour, and nothing downstream could tell.
//   2. Is an index past the end REFUSED rather than clamped? thumbnail() clamps on purpose (a
//      filmstrip wants a picture); a render must be told, or it bakes a freeze.
//   3. Does this file's alpha reach a DRAWABLE? Not what the container declares — what arrives at
//      surfaceMedia.getDrawable, since that is what a bake reads and writes. Hap5 (DXT5) carries its
//      alpha in the frame; HapQ Alpha (HapM) carries it in a SECOND texture that this decoder does
//      not keep, so the two answers differ and only one of them is the truth about a render.
//
// It runs its own Electron with its own main file, so it neither needs nor disturbs a running editor
// — the single-instance lock belongs to the app, not to this.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const REPO = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'hap-exact');

(async () => {
  const file = process.argv[2] || process.env.ARTLUX_HAP;
  if (!file) {
    console.error('usage: npm run test:hap-exact -- <path to a HAP .mov>   (or set ARTLUX_HAP)');
    process.exit(2);
  }
  if (!fs.existsSync(file)) {
    console.error('no such file: ' + file);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(REPO, 'native', 'hap', 'hap.node'))) {
    console.error('native/hap/hap.node is not built — run: npm run build:native');
    process.exit(2);
  }

  await esbuild.build({
    entryPoints: [path.join(DIR, 'harness.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
    outfile: path.join(DIR, 'bundle.js'),
    absWorkingDir: REPO,
    nodePaths: [path.join(REPO, 'node_modules')],
    // The REAL uploader and the REAL frame type — a copy here would prove only that the copy works.
    alias: {
      '@hapgl': path.join(REPO, 'plugins/hap/src/hapGL.ts'),
      '@haptypes': path.join(REPO, 'plugins/hap/src/types.ts'),
    },
    external: ['electron'],
    logLevel: 'warning',
  });

  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    execFileSync(electron, [path.join(DIR, 'main.js'), file], { stdio: 'inherit', env });
  } catch (e) {
    process.exit(typeof e.status === 'number' ? e.status : 1);
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
