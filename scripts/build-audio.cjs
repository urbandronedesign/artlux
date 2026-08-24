// Builds the native JUCE audio engine (native/audio-engine) with cmake-js and copies the addon to
// where BOTH the loader and the packager expect it. This is the C++ sibling of `cargo build` +
// scripts/copy-native.cjs — cmake-js is the "cargo" here, so build and copy live in one script.
//
// WHY THIS EXISTS (the bug it closes): the engine was only ever built by hand
// (`cd native/audio-engine && npx cmake-js build`). Nothing in npm, CI, or electron-builder touched
// it, and plugins/audio/src/audioManager.ts GRACEFULLY DEGRADES when the addon is missing — so a
// release built without it starts fine, renders the entire audio UI, and produces NO SOUND and NO
// ERROR. Every failure path below is therefore LOUD.
//
// WHERE THE ADDON MUST LAND — audioManager.ts:61-65 probes, in order:
//   1. <resourcesPath>/audio-engine.node                      ← packaged (electron-builder extraResources)
//   2. native/audio-engine/build/Release/audio_engine.node    ← cmake-js output (dev)
//   3. native/audio-engine/audio_engine.node                  ← the copy this script makes
// cmake target is `audio_engine` (UNDERSCORE, from project() in CMakeLists.txt); the packaged
// resource is `audio-engine.node` (HYPHEN, matching output-engine.node / spout-receiver.node /
// hap.node). Keep both spellings straight — package.json maps one to the other.
//
// MANDATORY-VS-OPTIONAL (see docs/DEVELOPMENT.md → Audio engine):
//   `npm run build:audio`  → strict. Used by CI and by `npm run package` / `package:dir`.
//   `npm run build:native` → runs this with --optional: a cargo-only contributor with no CMake/C++
//     toolchain is NOT blocked, but gets a banner telling them audio is dead. Never silent.
//   `--check`              → no build; just assert the addon EXISTS. Kept for ad-hoc verification.
//
// THE PACKAGING SCRIPTS BUILD, THEY DO NOT --check. `--check` proves the addon exists; it says
// NOTHING about whether it is CURRENT. Guarding `package` with it meant you could edit engine.cpp,
// run `npm run package`, watch --check print "ok", and ship the PREVIOUS engine — the very
// silent-stale-binary failure this file exists to prevent, reintroduced one layer up. (Found by the
// adversarial review of this change, not by its author.) The governing rule: BUILD STRICTLY WHEREVER
// AN ARTIFACT IS PRODUCED FOR SOMEONE ELSE. Packaging is exactly that, so packaging builds. The cost
// is that cutting an installer now requires a C++ toolchain — which is correct: the alternative is
// cutting an installer that is silently mute. On CI the rebuild is an incremental no-op, because the
// workflow's strict build step has already run.
// Unlike native/ndi/ndi.node (a committed Windows-only prebuilt), this addon CANNOT be committed:
// it is platform-specific and every OS needs its own, so it must be BUILT on each machine/runner.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OPTIONAL = process.argv.includes('--optional');
const CHECK_ONLY = process.argv.includes('--check');

const base = path.join(__dirname, '..', 'native', 'audio-engine');
const dest = path.join(base, 'audio_engine.node'); // loader probe #3 + electron-builder's `from`

// A missing engine is a SILENT no-sound release. Shout about it.
function fail(reason, hint) {
  const line = '='.repeat(78);
  const log = OPTIONAL ? console.warn : console.error;
  log(`\n${line}`);
  log(OPTIONAL ? '  WARNING: THE NATIVE AUDIO ENGINE WAS NOT BUILT' : '  ERROR: THE NATIVE AUDIO ENGINE WAS NOT BUILT');
  log(line);
  log(`  ${reason}`);
  if (hint) log(`  ${hint}`);
  log('');
  log('  Consequence: the app still starts and the ENTIRE audio UI still renders,');
  log('  but there is NO SOUND (plugins/audio degrades to a no-op and only whispers');
  log('  "[audio] native engine unavailable" to the console).');
  log('');
  log('  Fix: install CMake >= 3.23 + a C++17 toolchain, then `npm run build:audio`.');
  log('  DO NOT SHIP AN INSTALLER BUILT THIS WAY.');
  log(`${line}\n`);
  process.exit(OPTIONAL ? 0 : 1);
}

if (CHECK_ONLY) {
  if (!fs.existsSync(dest)) {
    fail('Packaging was about to cut an installer with no audio engine.',
         `Expected: ${path.relative(process.cwd(), dest)}`);
  }
  console.log(`[build-audio] ok — ${path.relative(process.cwd(), dest)} present`);
  process.exit(0);
}

// cmake-js + node-addon-api live in native/audio-engine/package.json. That directory is NOT an npm
// workspace (root workspaces are packages/* and plugins/*), so a root `npm ci` does not install them
// — CI would otherwise fail here with "cmake-js not found". Install on demand.
const cmakeJs = path.join(base, 'node_modules', 'cmake-js', 'bin', 'cmake-js');
if (!fs.existsSync(cmakeJs)) {
  console.log('[build-audio] installing native/audio-engine deps (cmake-js + node-addon-api)…');
  const install = spawnSync('npm', ['ci'], { cwd: base, stdio: 'inherit', shell: process.platform === 'win32' });
  if (install.status !== 0) fail('npm ci failed in native/audio-engine.');
}

// Build. cmake-js configures + builds in native/audio-engine/build; CMakeLists FetchContent-clones
// JUCE 8.0.14 and libspatialaudio 0.4.0 on the first run (slow, then cached in build/).
// NOTE: the addon is N-API (NAPI_VERSION=8), so it is runtime-agnostic — a build against Node's
// headers loads in Electron 42 unchanged. No --runtime=electron needed.
// ── ASIO: OPT-IN, VIA ONE ENVIRONMENT VARIABLE ──────────────────────────────────────────────────
//
// WHY ANYONE NEEDS THIS. On Windows, most multichannel interfaces expose only OUTPUTS 1-2 to WASAPI
// once the vendor's own driver is installed, and everything above that through ASIO. Measured on a
// Scarlett 6i6: on the generic USB-audio-class driver it opened SIX channels on every WASAPI mode; the
// moment Focusrite's driver replaced it, the same device opened TWO, on every mode, at every requested
// count. That is not a fault to debug — it is how the driver is built — and the only way to the other
// four outputs is ASIO.
//
// It stays OFF by default and that is a licence decision, not an oversight: the Steinberg ASIO SDK is
// not redistributable, cannot be vendored here, and cannot be fetched by CI. Enabling it also adds
// Steinberg's terms to a build that already carries JUCE's and libspatialaudio's — see NOTICE and the
// long note in native/audio-engine/CMakeLists.txt. So the SDK is something an operator downloads and
// accepts for themselves; this only removes the need to hand-run cmake afterwards.
//
//     set ARTLUX_ASIO_SDK=C:\path\to\asiosdk\common   (the directory containing iasiodrv.h)
//     npm run build:audio
const asioSdk = process.env.ARTLUX_ASIO_SDK;
const cmakeArgs = [];
if (asioSdk) {
  if (!fs.existsSync(path.join(asioSdk, 'iasiodrv.h'))) {
    fail(`ARTLUX_ASIO_SDK is set to ${asioSdk}, but there is no iasiodrv.h there.`,
         'Point it at the SDK\'s `common` directory — the one holding iasiodrv.h, asio.h, asiodrivers.cpp.');
  }
  // Forward slashes: CMake treats a backslash as an escape, so a Windows path pasted verbatim into a
  // -D value silently mangles (C:\asiosdk\common → C:asiosdkcommon) and the SDK is then "not found"
  // at a path nobody typed.
  const sdk = asioSdk.replace(/\\/g, '/');
  cmakeArgs.push('--CDARTLUX_ENABLE_ASIO=ON', `--CDASIO_SDK_DIR=${sdk}`);
  console.log(`[build-audio] ASIO ENABLED from ${sdk}`);
  console.log('[build-audio] this build carries Steinberg\'s licence terms in addition to JUCE\'s — see NOTICE.');
} else {
  // ⚠ TURNING IT OFF HAS TO BE SAID OUT LOUD. A CMake cache REMEMBERS: once a tree has been
  // configured with ARTLUX_ENABLE_ASIO=ON, simply unsetting the environment variable changes
  // nothing, because with no defines to pass this script used to skip the configure pass entirely
  // and `build` happily reuses the cached ON. The result is the dangerous direction of a stale
  // binary: a developer who clears ARTLUX_ASIO_SDK, rebuilds, sees a clean successful build, and
  // ships an ASIO-enabled addon under a licence that requires a countersigned agreement first
  // (NOTICE §1). The file header already warns about defines not taking effect; this is the same
  // failure with the sign flipped, and it is the one that can put an unlicensed binary in a release.
  //
  // So OFF is now passed explicitly, every time, and scripts/verify-asio-licence.cjs re-checks the
  // built artifact rather than trusting that this worked.
  cmakeArgs.push('--CDARTLUX_ENABLE_ASIO=OFF');
}

// Build. cmake-js configures + builds in native/audio-engine/build; CMakeLists FetchContent-clones
// JUCE 8.0.14 and libspatialaudio 0.4.0 on the first run (slow, then cached in build/).
// NOTE: the addon is N-API (NAPI_VERSION=8), so it is runtime-agnostic — a build against Node's
// headers loads in Electron 42 unchanged. No --runtime=electron needed.
//
// ⚠ A DEFINE NEEDS ITS OWN `configure` PASS. `build` configures only "if required", and an already-
// configured tree is not required — so flipping ARTLUX_ENABLE_ASIO with `build` alone would print a
// cheerful success and produce the SAME addon as before, ASIO silently absent. That is the stale-binary
// failure this file's header is about, one layer further in.
//
// `configure`, NOT `reconfigure`: reconfigure CLEANS the build directory first, which throws away the
// FetchContent clones of JUCE and libspatialaudio and turns a two-minute rebuild into a fresh download.
// Passing -D to an existing cache updates it in place, which is all that is wanted.
console.log('[build-audio] cmake-js build (JUCE + libspatialaudio)…');
// Unconditional: cmakeArgs always carries an explicit ARTLUX_ENABLE_ASIO now, ON or OFF, so the
// cache can never keep a value the environment no longer asks for.
const cfg = spawnSync(process.execPath, [cmakeJs, 'configure', ...cmakeArgs], { cwd: base, stdio: 'inherit' });
if (cfg.status !== 0) fail('cmake-js configure failed (see the output above).');
const build = spawnSync(process.execPath, [cmakeJs, 'build'], { cwd: base, stdio: 'inherit' });
if (build.status !== 0) {
  fail('cmake-js build failed (see the output above).',
       'On Windows LNK1104 = the dev app is RUNNING and holding audio_engine.node — CLOSE IT and retry.');
}

// Copy the addon next to its crate, mirroring scripts/copy-native.cjs.
const src = path.join(base, 'build', 'Release', 'audio_engine.node');
if (!fs.existsSync(src)) {
  fail(`cmake-js reported success but produced no addon at ${path.relative(process.cwd(), src)}.`);
}
fs.copyFileSync(src, dest);
console.log(`[build-audio] ${path.basename(src)} -> ${path.relative(process.cwd(), dest)}`);
