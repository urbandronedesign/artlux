// PROVE THAT A MATTE PAIR RECOMBINES INTO THE ALPHA IT STARTED WITH.
//
//   npm run test:matte-gl
//
// Chromium's VideoEncoder refuses `alpha: 'keep'` for every codec, so a transparent bake writes its
// alpha as the LUMA of a second video and gpu/matteGL puts the two back together. That module is the
// one place where "the transparency came back" is decided, and it fails in a way nobody would notice
// from a screenshot: a wrong sense or a missed premultiply gives a picture that looks plausible and
// composites wrongly over whatever is beneath it.
//
// So: a known colour split and a known alpha RAMP go in, and the recombined RGBA is read back through
// an ordinary 2D canvas — the same path the compositor uses. A ramp rather than a hard edge because it
// catches a matte that is inverted, quantised, or silently binary.
const path = require('path');
const { execFileSync } = require('child_process');
const esbuild = require('esbuild');

const REPO = path.join(__dirname, '..');
const DIR = path.join(__dirname, 'matte-gl');

(async () => {
  await esbuild.build({
    entryPoints: [path.join(DIR, 'harness.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2022',
    outfile: path.join(DIR, 'bundle.js'),
    absWorkingDir: REPO,
    nodePaths: [path.join(REPO, 'node_modules')],
    alias: { '@matte': path.join(REPO, 'src/renderer/gpu/matteGL.ts') },
    logLevel: 'warning',
  });
  const electron = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    execFileSync(electron, [path.join(DIR, 'main.js')], { stdio: 'inherit', env });
  } catch (e) {
    process.exit(typeof e.status === 'number' ? e.status : 1);
  }
})().catch((e) => { console.error(String(e)); process.exit(1); });
