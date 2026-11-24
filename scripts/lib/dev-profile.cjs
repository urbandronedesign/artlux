// A SCRATCH PROFILE FOR A TEST THAT LAUNCHES THE DEV BUILD (`electron-vite dev` / `npm run dev`).
//
//   const profile = require('./lib/dev-profile.cjs')('scene-timelines');
//   spawn(bin, ['dev', ...profile.cliArgs], { env: profile.env(process.env), … });   // read/write profile.prefsFile
//
// These tests used to run on the OWNER'S profile (%APPDATA%\ArtLux), backing up and restoring
// artlux-prefs.json around themselves. A backup covers one file: everything else the app writes there —
// localStorage (a forced `artlux.scene3dWebGL` left the owner's 3D view on WebGL, 2026-11-23), machine logs,
// paired tablets, the show-control playlist that hijacked every broadcast launch (2026-10-24) — stayed behind,
// and a crashed run did not even restore the prefs. A profile of the test's own leaves nothing to restore.
//
// HOW: `electron-vite dev -- --user-data-dir=<scratch>` — everything after `--` reaches the Electron it spawns,
// and Chromium applies the switch before main runs (src/main/appPaths.ts honours it). It also gives the test its
// OWN single-instance lock, so a launch never lands in the owner's open window.
// ⚠ NOT the ELECTRON_CLI_ARGS environment variable, though that is what electron-vite passes internally: its CLI
// always has a `--` list (empty when none is given) and OVERWRITES the variable with it, so a profile set there
// silently never arrives — the first run of this helper launched on the owner's profile exactly that way
// (2026-11-24). Spread `cliArgs` into the dev command instead; `npm run dev -- -- …` callers add `cliArg`.
// ELECTRON_RUN_AS_NODE is dropped: inherited from a tool's shell, it makes Electron boot as plain Node.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

module.exports = function devProfile(name) {
  const dir = path.join(os.tmpdir(), `artlux-${name}`, 'profile');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    prefsFile: path.join(dir, 'artlux-prefs.json'),
    /** The Electron switch itself, for a caller that already passes `-- …` (npm run dev -- -- …). */
    cliArg: `--user-data-dir=${dir}`,
    /** For `electron-vite dev`: ['--', '--user-data-dir=…']. */
    cliArgs: ['--', `--user-data-dir=${dir}`],
    env(base) {
      const env = { ...base };
      delete env.ELECTRON_RUN_AS_NODE;
      return env;
    },
  };
};
