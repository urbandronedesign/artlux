#!/usr/bin/env node
/*
 * ASIO build gate — runs from `npm run package` and from .github/workflows/build.yml, after the addon
 * is built and before electron-builder wraps it into an installer.
 *
 * ⚠ THIS SCRIPT'S JOB IS THE OPPOSITE OF WHAT IT WAS, AND THAT IS DELIBERATE.
 *
 * It was written to REFUSE an ASIO build, on the reasoning that ASIO was an accident waiting to be
 * enabled by a stray environment variable. ASIO is now a shipped feature of ArtLux on Windows, so the
 * accident it guards against has inverted: the danger is a release that SILENTLY LOST it.
 *
 * That is not hypothetical. A CMake cache remembers, and `cmake-js build` reuses it — so a tree
 * configured before ASIO became the default kept producing a WASAPI-only addon while every log line
 * said success. An installer built from it looks perfect and cannot reach outputs 3 and up on any
 * interface with a vendor driver, which is the exact silence this whole feature exists to end. Nothing
 * else in the build would notice: every native module in this app degrades quietly by design.
 *
 * WHY IT READS THE BINARY. The obvious implementation is a flag or a marker file. Both describe what a
 * build was ASKED to do; only the artifact says what it IS, and they came apart in practice — a build
 * run with no environment variables at all still configured against a cached external SDK path. JUCE
 * compiles `ASIOAudioIODeviceType` into juce_win32_ASIO.cpp only under JUCE_ASIO=1, so the symbol's
 * presence is the answer and cannot disagree with what ships.
 *
 * Matching that class name rather than the bare word "ASIO" matters: driver NAMES like "ASIO
 * DirectX Full Duplex" appear as string literals in unrelated code paths, so a naive search reports a
 * false positive on an ordinary WASAPI-only build.
 *
 * Run:  node scripts/verify-asio-licence.cjs [--warn-only]
 *
 * To ship a deliberately ASIO-free build (the licence-free artifact), build it that way and say so:
 *     set ARTLUX_ASIO=0
 *     npm run build:audio && npm run package
 *
 * THE LICENCE POSITION, from the SDK's own LICENSE.txt (2.3.4, 2025-10-15): the ASIO SDK is dual
 * licensed, proprietary or GPLv3. The proprietary branch restricts redistributing THE SDK, not a
 * binary compiled against it, and gates publishing on an agreement countersigned by Steinberg; the
 * GPLv3 branch requires the product itself be GPLv3. ArtLux ships ASIO under a decision its owners
 * have taken and recorded in NOTICE. Attribution is required under either branch and is carried in
 * NOTICE and shared/credits.ts — this script checks that it is still there, because an attribution
 * that quietly disappears is the one licence obligation a build CAN violate by accident.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ADDON = path.join(ROOT, 'native', 'audio-engine', 'audio_engine.node');
const ASIO_MARKER = 'ASIOAudioIODeviceType';

const WARN_ONLY = process.argv.slice(2).includes('--warn-only');
const DELIBERATELY_OFF = process.env.ARTLUX_ASIO === '0';

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const bail = (lines) => {
  console.error('');
  lines.forEach((l) => console.error(l));
  console.error('');
  process.exit(WARN_ONLY ? 0 : 1);
};

// ── 1. Is the addon there at all? Not this script's call to make. ────────────────────────────────
if (!fs.existsSync(ADDON)) {
  console.log(`${green('✓')} [asio] no audio addon present — nothing to check.`);
  process.exit(0);
}

const hasAsio = fs.readFileSync(ADDON).includes(ASIO_MARKER);

// ── 2. Attribution must survive, whichever branch the project is on ──────────────────────────────
const attributionMissing = [];
if (hasAsio) {
  const notice = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8');
  if (!/steinberg/i.test(notice)) attributionMissing.push('NOTICE has no Steinberg / ASIO entry');
  const creditsPath = path.join(ROOT, 'shared', 'credits.ts');
  if (fs.existsSync(creditsPath) && !/asio/i.test(fs.readFileSync(creditsPath, 'utf8'))) {
    attributionMissing.push('shared/credits.ts does not name ASIO (it is shown at startup and in About)');
  }
}

// ── 3. The verdicts ──────────────────────────────────────────────────────────────────────────────
if (process.platform !== 'win32') {
  console.log(`${green('✓')} [asio] ${process.platform} build — ASIO is a Windows-only driver model, correctly absent.`);
  process.exit(0);
}

if (DELIBERATELY_OFF) {
  if (hasAsio) {
    bail([
      red('✗ [asio] ARTLUX_ASIO=0 was set, but the addon still has ASIO compiled in.'),
      '',
      '  The CMake cache almost certainly kept the previous value. Re-run the build so the define is',
      '  passed explicitly — build-audio.cjs forces it in both directions:',
      '      npm run build:audio',
    ]);
  }
  console.log(`${yellow('!')} [asio] ARTLUX_ASIO=0 — packaging a deliberately ASIO-free build.`);
  console.log('  On interfaces whose vendor driver exposes only outputs 1-2 to Windows, this installer');
  console.log('  cannot reach outputs 3 and up. That is the intended trade for a Steinberg-free artifact.');
  process.exit(0);
}

if (!hasAsio) {
  bail([
    red('✗ [asio] REFUSING TO PACKAGE: this Windows build has NO ASIO, and ASIO is a shipped feature.'),
    '',
    `  ${path.relative(ROOT, ADDON)} does not contain ${ASIO_MARKER}, so it was built with JUCE_ASIO=0.`,
    '  An installer from this addon looks perfectly healthy and silently cannot reach outputs 3 and up',
    '  on any interface with a vendor driver installed — measured on a Scarlett 6i6, where the vendor',
    '  driver gives WASAPI two channels and routes the rest through ASIO alone.',
    '',
    '  The usual cause is a stale CMake cache from before ASIO became the default. Rebuild:',
    '      npm run build:audio',
    '',
    '  If you MEANT to build without it, say so and this becomes a warning instead:',
    '      set ARTLUX_ASIO=0',
  ]);
}

if (attributionMissing.length) {
  bail([
    red('✗ [asio] REFUSING TO PACKAGE: ASIO is compiled in but its attribution is missing.'),
    '',
    ...attributionMissing.map((m) => `  - ${m}`),
    '',
    '  Attribution is required under BOTH branches of the Steinberg SDK licence. It is also the one',
    '  obligation a build can drop by accident, which is why it is checked here rather than trusted.',
  ]);
}

console.log(`${green('✓')} [asio] ASIO compiled in, attribution present in NOTICE and credits.`);
