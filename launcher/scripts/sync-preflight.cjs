#!/usr/bin/env node
/*
 * Copy the app's preflight.ps1 into the launcher's bundled resources.
 *
 * WHY A COPY AT ALL: the launcher's job is to check a machine BEFORE ArtLux is installed, where
 * <install>\resources\scripts\preflight.ps1 does not exist yet. The script is deliberately
 * self-contained (no dot-sourcing, no sibling files; an absent repo just makes its dev.* checks
 * SKIP), which is what makes shipping a second copy viable at all -- docs/INSTALL.md already tells
 * people to carry it to a venue on its own.
 *
 * WHY GENERATED RATHER THAN COMMITTED: a committed copy is a fork with no mechanism to notice it has
 * drifted. Regenerating on every build means the bundled script is the app's script, always. The
 * copy is gitignored and this runs from `npm run build` and `npm run dev`, both of which Tauri
 * invokes itself (beforeBuildCommand / beforeDevCommand), so there is no path that bundles a stale
 * one.
 */
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', 'scripts', 'preflight.ps1');
const dstDir = path.join(__dirname, '..', 'src-tauri', 'resources');
const dst = path.join(dstDir, 'preflight.ps1');

if (!fs.existsSync(src)) {
  // Hard failure, not a warning. Shipping a launcher whose Health tab silently has no script is the
  // same class of bug as the extraResources glob that shipped installers with no OpenCV runtime.
  console.error(`\x1b[31m✗\x1b[0m sync-preflight: ${src} does not exist — cannot bundle the machine check.`);
  process.exit(1);
}

fs.mkdirSync(dstDir, { recursive: true });
const before = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
const now = fs.readFileSync(src);
if (before && before.equals(now)) {
  console.log(`\x1b[32m✓\x1b[0m sync-preflight: bundled copy already current (${(now.length / 1024).toFixed(1)} KB)`);
} else {
  fs.writeFileSync(dst, now);
  console.log(`\x1b[32m✓\x1b[0m sync-preflight: refreshed from scripts/preflight.ps1 (${(now.length / 1024).toFixed(1)} KB)`);
}
