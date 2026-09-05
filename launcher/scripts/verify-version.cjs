#!/usr/bin/env node
/*
 * Assert the launcher's FIVE version sites agree.
 *
 * THE BUG THIS EXISTS FOR, which shipped twice:
 *   - launcher-v0.1.1 bumped package.json and Cargo.toml and left BOTH lockfiles at 0.1.0.
 *   - launcher-v0.1.2 fixed the lockfiles and left `tauri.conf.json` at 0.1.1 — so the published
 *     release `launcher-v0.1.2` contains an asset named `ArtLuxLauncher_0.1.1_x64-setup.exe`, the
 *     installer's product version is 0.1.1, and the running app reports 0.1.2. Nothing failed.
 *
 * Each site is read by a DIFFERENT consumer, which is why they drift without anyone noticing:
 *   tauri.conf.json   -> the bundle version: the installer FILENAME and the PE version resource.
 *                        Tauri prefers this field and only falls back to Cargo.toml when it is
 *                        absent — the reason the 0.1.2 miss was invisible.
 *   Cargo.toml        -> CARGO_PKG_VERSION, i.e. own_version() and the HTTP user-agent.
 *   package.json      -> the `version:` CI writes into launcher-latest.yml, which is what an
 *                        installed launcher compares itself against to decide it is out of date.
 *   Cargo.lock        -> must match Cargo.toml or `cargo build --locked` fails.
 *   package-lock.json -> must match package.json; `npm ci` does NOT complain when it does not.
 *
 * A mismatch is not cosmetic: package.json above Cargo.toml offers an update that installs the same
 * build and never clears, and a stale tauri.conf.json leaves NSIS thinking a new install is the
 * version already present.
 *
 * Run: node scripts/verify-version.cjs   (wired into `npm run package` and the launcher CI job)
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));

function fail(msg) {
  console.error(`\x1b[31m✗\x1b[0m verify-version: ${msg}`);
  process.exit(1);
}

// Cargo.lock holds every dependency; take the version from the artlux-launcher entry only.
const lockEntry = read('src-tauri/Cargo.lock').match(
  /name = "artlux-launcher"\r?\nversion = "([^"]+)"/,
);
if (!lockEntry) fail('Cargo.lock has no artlux-launcher entry.');

const pkgLock = json('package-lock.json');

const sites = [
  ['src-tauri/tauri.conf.json', json('src-tauri/tauri.conf.json').version, 'installer filename + PE version'],
  ['src-tauri/Cargo.toml', (read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m) || [])[1], 'own_version()'],
  ['src-tauri/Cargo.lock', lockEntry[1], 'cargo --locked'],
  ['package.json', json('package.json').version, 'launcher-latest.yml, i.e. the update check'],
  ['package-lock.json', pkgLock.version, 'npm ci'],
  ['package-lock.json (packages."")', pkgLock.packages?.['']?.version, 'npm ci'],
];

const missing = sites.filter(([, v]) => !v);
if (missing.length) fail(`could not read a version from ${missing.map(([f]) => f).join(', ')}.`);

const distinct = [...new Set(sites.map(([, v]) => v))];
if (distinct.length > 1) {
  const rows = sites.map(([f, v, why]) => `    ${v.padEnd(10)} ${f}  (${why})`).join('\n');
  fail(
    `the launcher's version sites disagree — a release cut from this tree would ship mislabelled:\n${rows}\n` +
      `  Set all of them to the same value. See docs/LAUNCHER.md -> Releasing.`,
  );
}

console.log(`\x1b[32m✓\x1b[0m verify-version: all ${sites.length} launcher version sites agree (${distinct[0]})`);
