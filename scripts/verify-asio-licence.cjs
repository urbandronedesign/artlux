#!/usr/bin/env node
/*
 * ASIO release gate — run from `npm run package` / `package:dir`, AFTER the addon is built and
 * BEFORE electron-builder wraps it into an installer.
 *
 * THE TRAP THIS EXISTS TO CLOSE. ASIO is enabled by an ENVIRONMENT VARIABLE (ARTLUX_ASIO_SDK), and
 * `npm run package` calls `scripts/build-audio.cjs` like any other build. So a machine where that
 * variable is set — a developer's shell profile, a system-wide variable set once and forgotten, a
 * terminal still open from an ASIO session — produces a perfectly successful, perfectly silent
 * ASIO-enabled installer. Nothing in the build output says "you have just built something you may
 * not publish yet".
 *
 * And publishing is exactly what is gated. The Steinberg ASIO SDK's own LICENSE.txt (2.3.4):
 *
 *     "Before publishing a software under the proprietary license, you need to obtain a copy of
 *      the License Agreement signed by Steinberg Media Technologies GmbH."
 *
 * Building and testing locally requires nothing. Handing someone an installer requires that
 * countersigned agreement first. Pushing a `v*` tag runs a CI matrix that publishes a GitHub
 * Release, so a tag is publishing. See NOTICE §1 (Steinberg ASIO SDK) for the full position and the
 * three-item checklist this script enforces the first item of.
 *
 * WHY IT READS THE BINARY AND NOT A FLAG. The obvious implementation is a marker file written by
 * build-audio.cjs. Markers drift: the build that wrote it is not necessarily the build being
 * packaged, and a stale marker fails in the dangerous direction — it says OFF while the addon says
 * ON. So this reads ground truth out of the artifact itself. JUCE compiles `ASIOAudioIODeviceType`
 * into the binary only when JUCE_ASIO=1, so its presence IS the answer, and it cannot disagree with
 * what ships.
 *
 * Run:  node scripts/verify-asio-licence.cjs [--warn-only]
 *
 * To package an ASIO build deliberately, set the agreement reference — anything that identifies the
 * countersigned document, e.g. the date it was returned:
 *
 *     set ARTLUX_ASIO_AGREEMENT=signed-2026-09-01-steinberg
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'native', 'audio-engine', 'audio_engine.node');

// JUCE names this class in juce_win32_ASIO.cpp, which is compiled only under JUCE_ASIO=1. Matching a
// class name rather than the bare word "ASIO" matters: "ASIO DirectX Full Duplex" and similar driver
// NAMES appear as string literals in unrelated code paths, so a naive search for "ASIO" reports a
// false positive on an ordinary WASAPI-only build.
const ASIO_MARKER = 'ASIOAudioIODeviceType';

const WARN_ONLY = process.argv.slice(2).includes('--warn-only');
const AGREEMENT = (process.env.ARTLUX_ASIO_AGREEMENT || '').trim();

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

if (!fs.existsSync(ADDON)) {
  // Not this script's business. The audio addon is optional in some build paths, and
  // verify-package-resources.cjs is the script that decides whether a missing resource is fatal.
  console.log(`${green('✓')} [asio-gate] no audio addon present — nothing to check.`);
  process.exit(0);
}

const hasAsio = fs.readFileSync(ADDON).includes(ASIO_MARKER);

if (!hasAsio) {
  console.log(`${green('✓')} [asio-gate] audio_engine.node carries no ASIO — free to publish.`);
  process.exit(0);
}

if (AGREEMENT) {
  console.log(`${yellow('!')} [asio-gate] PACKAGING AN ASIO-ENABLED BUILD.`);
  console.log(`  Agreement reference: ${AGREEMENT}`);
  console.log('  Confirm the rest of the NOTICE §1 checklist before this installer leaves the machine:');
  console.log('    - the countersigned Steinberg agreement is filed beside NOTICE');
  console.log('    - the ASIO credit is present in shared/credits.ts');
  console.log('    - the ASIO trademark is used per Steinberg\'s Usage Guidelines (unaltered, product context)');
  process.exit(0);
}

console.error('');
console.error(red('✗ [asio-gate] REFUSING TO PACKAGE: this build has ASIO compiled in.'));
console.error('');
console.error(`  ${path.relative(ROOT, ADDON)} contains ${ASIO_MARKER}, so it was built with`);
console.error('  ARTLUX_ASIO_SDK set. That is fine to build and fine to run here. It is NOT fine to');
console.error('  publish, because the Steinberg ASIO SDK licence says:');
console.error('');
console.error('    "Before publishing a software under the proprietary license, you need to obtain');
console.error('     a copy of the License Agreement signed by Steinberg Media Technologies GmbH."');
console.error('');
console.error('  Pushing a v* tag publishes a GitHub Release, which is publishing. See NOTICE §1.');
console.error('');
console.error('  TO BUILD A PUBLISHABLE INSTALLER — clear the variable and rebuild the addon:');
console.error('      set ARTLUX_ASIO_SDK=');
console.error('      npm run build:audio        (build-audio.cjs forces ASIO back OFF in the CMake cache)');
console.error('');
console.error('  TO PACKAGE ASIO DELIBERATELY, once the agreement is countersigned and filed:');
console.error('      set ARTLUX_ASIO_AGREEMENT=signed-YYYY-MM-DD-steinberg');
console.error('');

process.exit(WARN_ONLY ? 0 : 1);
