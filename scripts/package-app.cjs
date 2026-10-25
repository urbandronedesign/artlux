#!/usr/bin/env node
/*
 * Build and package ONE app of the suite: `node scripts/package-app.cjs <show|calibrator> [--dir]`.
 * Wired as `npm run package:show[:dir]` / `npm run package:calibrator[:dir]` (suite plan Phase 3,
 * plans/artlux-suite-show-calibrator.md §8a).
 *
 * One tree, two products. Both are DERIVED from the single electron-builder config in package.json
 * `build` — so a resource, a fuse or a signing rule added there reaches both, and only what makes the two
 * apps different lives here:
 *
 *   ArtLux Show        productName stays `ArtLux` ON PURPOSE: it is what electron-builder names the exe
 *                      (ArtLux.exe), the install folder (C:\Program Files\ArtLux), the userData folder
 *                      (%APPDATA%\ArtLux) and the artifact (ArtLux-<v>-x64.exe → latest.yml). Every one
 *                      of those is a contract — the Launcher, preflight, the watchdog task, the fixed-name
 *                      download — so an installed "ArtLux" updates into Show IN PLACE. The operator-facing
 *                      name, "ArtLux Show", is the Start-menu shortcut and the uninstall entry.
 *                      Drops calib.node and the OpenCV DLL: Show plays calibrations, it makes none.
 *   ArtLux Calibrator  its own appId, folder (C:\Program Files\ArtLux Calibrator), artifact and update
 *                      channel (calibrator.yml beside latest.yml). Shares Show's userData (main/appPaths.ts).
 *                      Drops the show side: the audio engine, the fixture library, NDI, Spout, the LiDAR
 *                      emitter, the watchdog task scripts.
 *
 * `--dir` builds the unpacked folder only (level 2 of §8a): no installer, no redistributables needed.
 * Output: release/<app>/ — the two never overwrite each other.
 */
const { execSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const [app, ...flags] = process.argv.slice(2);
const DIR_ONLY = flags.includes('--dir');
// --ci: the release workflow stages the redistributables, the OpenCV DLL and the audio engine itself
// (.github/workflows/build.yml), per OS, and runs the licence gate — so here only build, check, package.
const CI = flags.includes('--ci');
if (!['show', 'calibrator'].includes(app)) {
  console.error('usage: node scripts/package-app.cjs <show|calibrator> [--dir] [--ci]');
  process.exit(2);
}

const pkg = require(path.join(ROOT, 'package.json'));
const base = JSON.parse(JSON.stringify(pkg.build));

// What each product leaves out, by the `from` path of the extraResources entry.
const DROP = {
  show: ['native/calib/calib.node', 'native/calib/opencv_world4110.dll'],
  calibrator: [
    'native/audio-engine/audio_engine.node', 'resources/fixture-library', 'scripts/lidar-emitter.cjs',
    'native/spout-receiver/spout-receiver.node', 'native/ndi/ndi.node', 'build/ndi/NDI-Runtime.exe',
    'scripts/install-watchdog-task.ps1', 'scripts/uninstall-watchdog-task.ps1', 'scripts/watchdog-check.ps1',
  ],
}[app];
const keep = (list) => (list ?? []).filter((r) => !DROP.includes(typeof r === 'string' ? r : r.from));

const config = {
  ...base,
  extraResources: keep(base.extraResources),
  win: { ...base.win, extraResources: keep(base.win?.extraResources) },
  directories: { ...base.directories, output: `release/${app}` },
};

if (app === 'show') {
  config.nsis = { ...base.nsis, shortcutName: 'ArtLux Show', uninstallDisplayName: 'ArtLux Show ${version}' };
} else {
  config.appId = 'com.urbandronedesign.artlux.calibrator';
  config.productName = 'ArtLux Calibrator';
  config.artifactName = 'ArtLux-Calibrator-${version}-${arch}.${ext}';
  config.nsis = { ...base.nsis, shortcutName: 'ArtLux Calibrator', uninstallDisplayName: 'ArtLux Calibrator ${version}' };
  // Its own update metadata (calibrator.yml), so electron-updater in one app never offers the other.
  config.publish = { ...base.publish, channel: 'calibrator' };
  // …and its own updater CACHE. electron-updater keeps downloaded installers in
  // %LOCALAPPDATA%\<name>-updater, named from package.json `name` — shared with Show it was one folder
  // for two products' pending updates (harmless, each checks the sha512, but never right). The name
  // does not reach userData: that comes from the product name and is pinned (main/appPaths.ts).
  config.extraMetadata = { ...(base.extraMetadata ?? {}), name: 'artlux-calibrator' };
  // The icon is the Calibrator's own once build/icon-calibrator.* exists (Phase 3, icons); until then the
  // shared mark, so a build never fails for want of artwork.
  const fs = require('node:fs');
  if (fs.existsSync(path.join(ROOT, 'build/icon-calibrator.ico'))) config.win.icon = 'build/icon-calibrator.ico';
  if (fs.existsSync(path.join(ROOT, 'build/icon-calibrator.png'))) {
    config.mac = { ...base.mac, icon: 'build/icon-calibrator.png' };
    config.linux = { ...base.linux, icon: 'build/icon-calibrator.png' };
  }
}

const run = (cmd, env = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

console.log(`[package] ${app}${DIR_ONLY ? ' (unpacked)' : ''} → release/${app}`);
// The guards first, as `npm run package` does — a build that breaks an invariant must not be packaged.
run('node scripts/verify-invariants.cjs');
if (!DIR_ONLY && !CI) {
  // An INSTALLER needs what `npm run package` stages: the redistributables, the OpenCV DLL, the audio
  // engine, and the resource check that fails a build electron-builder would otherwise ship incomplete.
  run('npm run prepack:assets');
  run('node scripts/build-audio.cjs');
  run('npm run verify:asio');
}
run('npx electron-vite build', { ARTLUX_APP: app });
if (!DIR_ONLY) run('npm run verify:resources');
run('node scripts/verify-plugins.cjs', { ARTLUX_APP: app });

// Through the CLI with a CONFIG FILE, not the programmatic API with an object: handed an object,
// electron-builder still merges package.json `build` underneath it, concatenating the extraResources
// arrays — every resource was copied twice, concurrently, to the same path (EBUSY), and the Show build
// would have carried the OpenCV DLL it is meant to drop. With --config, package.json `build` is ignored.
const fs = require('node:fs');
const cfgFile = path.join(ROOT, 'release', `builder-${app}.json`);
fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
run(`npx electron-builder --config "${cfgFile}" ${DIR_ONLY ? '--dir' : ''} --publish never`);
console.log(`[package] ${app}: done → release/${app}`);
