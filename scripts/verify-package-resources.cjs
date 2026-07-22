#!/usr/bin/env node
/*
 * extraResources presence verifier — run BEFORE electron-builder, from `npm run package`.
 *
 * The bug it guards against, which shipped for real: electron-builder resolves an extraResources
 * `from` path as a GLOB. A literal path that matches nothing is therefore not an error — it is a
 * silent skip. So a machine (or a CI runner) that never built `native/calib/opencv_world4110.dll`
 * produces a perfectly successful installer that is simply MISSING the file, and the failure only
 * appears on the end user's PC as `[calib] native OpenCV addon unavailable` in a console nobody reads.
 * Every native loader in this app degrades gracefully by design, which is exactly what makes a missing
 * resource invisible all the way from the build to the venue.
 *
 * That is not a hypothetical: `.github/workflows/build.yml` runs `build:native` (output-engine, spout,
 * hap, audio) but NEVER `build:calib`, so `opencv_world4110.dll` did not exist on any CI runner and
 * every published release shipped `calib.node` with no OpenCV runtime behind it.
 *
 * This script re-reads the SAME declarations electron-builder will use (package.json `build.extraResources`
 * plus the per-platform `build.<win|mac|linux>.extraResources`) and hard-fails if a declared source is
 * absent. Declarations are the single source of truth — add a resource to package.json and it is checked
 * here automatically, with no list to keep in sync.
 *
 * Run:  node scripts/verify-package-resources.cjs [--platform win|mac|linux] [--warn-only]
 * Wired as `npm run verify:resources`, and into `package` / `package:dir` ahead of electron-builder.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PKG = require(path.join(ROOT, 'package.json'));

const argv = process.argv.slice(2);
const WARN_ONLY = argv.includes('--warn-only');
const platArg = (() => {
  const i = argv.indexOf('--platform');
  return i >= 0 ? argv[i + 1] : null;
})();

// Which per-platform block applies. electron-builder merges the top-level extraResources with the
// block for the platform being built, so we mirror that instead of checking every platform's entries
// (a mac-only resource is not a failure when packaging on Windows).
const PLATFORM = platArg || ({ win32: 'win', darwin: 'mac', linux: 'linux' })[process.platform] || 'win';

function fail(msg) { console.error(`\x1b[31m✗\x1b[0m ${msg}`); }
function warn(msg) { console.warn(`\x1b[33m!\x1b[0m ${msg}`); }
function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }

// Normalise the several shapes electron-builder accepts: a bare string, or { from, to, filter }.
function normalise(entries) {
  if (!entries) return [];
  return (Array.isArray(entries) ? entries : [entries]).map((e) =>
    typeof e === 'string' ? { from: e, to: e } : e,
  ).filter((e) => e && e.from);
}

const declarations = [
  ...normalise(PKG.build?.extraResources).map((e) => ({ ...e, scope: 'all' })),
  ...normalise(PKG.build?.[PLATFORM]?.extraResources).map((e) => ({ ...e, scope: PLATFORM })),
];

if (!declarations.length) {
  warn('no extraResources declared in package.json — nothing to verify');
  process.exit(0);
}

let missing = 0;
let checked = 0;

for (const { from, to, scope } of declarations) {
  const abs = path.join(ROOT, from);

  // A `from` containing glob metacharacters is a directory/pattern copy; we can only assert that its
  // literal prefix exists (a pattern legitimately matching zero files is the author's problem, not ours).
  const isGlob = /[*?[\]{}]/.test(from);
  const probe = isGlob ? path.join(ROOT, from.split(/[*?[\]{}]/)[0]) : abs;

  checked++;
  if (!fs.existsSync(probe)) {
    missing++;
    fail(`[${scope}] MISSING  ${from}  →  resources/${to ?? from}`);
    continue;
  }

  // Size matters for the two big redistributables: a 0-byte or truncated file is a failed/partial
  // download that would otherwise sail through an existsSync check and ship broken.
  const st = fs.statSync(probe);
  if (st.isFile() && st.size === 0) {
    missing++;
    fail(`[${scope}] EMPTY    ${from} (0 bytes — failed download?)`);
    continue;
  }

  const size = st.isFile() ? ` (${(st.size / 1024 / 1024).toFixed(1)} MB)` : '/';
  ok(`[${scope}] ${from}${size}`);
}

console.log('');
if (missing) {
  const msg = `${missing} of ${checked} declared extraResources are missing — the installer would ship WITHOUT them.`;
  if (WARN_ONLY) { warn(msg); process.exit(0); }
  fail(msg);
  console.error(
    '\nFix, depending on which one:\n' +
    '  native/calib/opencv_world4110.dll  → npm run fetch:opencv   (or npm run build:calib on an OpenCV host)\n' +
    '  build/ndi/NDI-Runtime.exe          → npm run fetch:redist\n' +
    '  build/vcredist/vc_redist.x64.exe   → npm run fetch:redist\n' +
    '  native/*/*.node                    → npm run build:native / build:audio / build:ndi / build:nvwarp\n',
  );
  process.exit(1);
}
ok(`all ${checked} declared extraResources present (platform: ${PLATFORM})`);
