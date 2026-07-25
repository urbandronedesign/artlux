#!/usr/bin/env node
/*
 * Assert the built binary is the LAUNCHER, not something else that happened to be in target/release.
 *
 * THE BUG THIS EXISTS FOR, which shipped in launcher-v0.1.0: the crate briefly had two binaries
 * (src/main.rs and a src/bin/selftest.rs), so `tauri build` had two candidates and bundled the
 * WRONG one. The installer deployed the console self-test under the launcher's name, with a Start
 * Menu shortcut pointing at it — it installed cleanly, exited 0, and never opened a window. Setting
 * `mainBinaryName` made it worse: rather than selecting the right binary it RENAMED the wrong one,
 * overwriting the real launcher in target/release too.
 *
 * The structural fix is that the self-test is now a cargo *example* (never a bundle candidate). This
 * check is the guard: nothing about a wrong binary is visible in a build log, a file listing, or an
 * exit code, so it has to be asserted.
 *
 * Run: node scripts/verify-bundle.cjs   (wired into `npm run package` and the launcher CI job)
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src-tauri', 'target', 'release');
const exe = path.join(root, 'artlux-launcher.exe');

function fail(msg) {
  console.error(`\x1b[31m✗\x1b[0m verify-bundle: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(exe)) fail(`${exe} does not exist — build first.`);

const bytes = fs.readFileSync(exe);
const has = (s) => bytes.includes(Buffer.from(s, 'utf8'));

// Present only in the GUI binary: the window title comes from tauri.conf.json and the event name
// from the download module the UI listens to.
const MUST_HAVE = ['ArtLux Launcher', 'download://progress'];
// Present only in the self-test. If this is in the shipped binary, the wrong one was bundled.
const MUST_NOT_HAVE = ['SELFTEST OK', '1. INSTALL DETECTION'];

const missing = MUST_HAVE.filter((s) => !has(s));
const present = MUST_NOT_HAVE.filter((s) => has(s));

if (present.length) {
  fail(
    `the built binary contains ${present.map((s) => JSON.stringify(s)).join(', ')} — that is the ` +
      `SELF-TEST, not the launcher. It would install as an app that opens no window.`,
  );
}
if (missing.length) {
  fail(
    `the built binary is missing ${missing.map((s) => JSON.stringify(s)).join(', ')} — it does not ` +
      `look like the launcher GUI.`,
  );
}

// A GUI binary embeds the whole frontend bundle; the self-test was a third of the size. Not a
// precise threshold, just a floor that a console binary cannot clear.
const mb = bytes.length / 1024 / 1024;
if (mb < 5) fail(`the built binary is only ${mb.toFixed(1)} MB — too small to embed the UI.`);

console.log(`\x1b[32m✓\x1b[0m verify-bundle: artlux-launcher.exe is the launcher GUI (${mb.toFixed(1)} MB)`);
