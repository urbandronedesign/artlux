// Hard gate: assert the packaged macOS .app carries a VALID code signature.
//
// On Apple Silicon every Mach-O must be signed to execute at all — an *invalid* signature is worse
// than none: the kernel refuses to map the binary and Gatekeeper reports "ArtLux is damaged and
// can't be opened. You should move it to the Trash", which reads like a corrupt download and which
// `xattr -dr com.apple.quarantine` does NOT fix.
//
// This exists because that shipped once already. v0.2.1 ad-hoc signed the app in an `afterPack`
// hook; v0.19.1 added `electronFuses: { runAsNode: false }`, and electron-builder flips fuses AFTER
// afterPack (it rewrites bytes in the Electron binary — see "the fuses MUST be flipped right before
// signing" in app-builder-lib/platformPackager). That silently invalidated the signature the hook
// had just applied, and with no Developer ID in CI the built-in signing step re-signed nothing. Every
// mac dmg from v0.19.1 on was DOA, and nothing in the build went red.
//
// The signature now comes from electron-builder itself (`mac.identity: "-"`), which signs after the
// fuse flip. This script is the tripwire proving it stayed that way. No-op off macOS.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
  console.log('[verify-mac-signature] not macOS — skipped');
  process.exit(0);
}

const releaseDir = path.join(__dirname, '..', 'release');
// electron-builder emits release/mac-arm64/ArtLux.app (or release/mac/ for x64).
const apps = fs.existsSync(releaseDir)
  ? fs
      .readdirSync(releaseDir)
      .filter((d) => d === 'mac' || d.startsWith('mac-'))
      .flatMap((d) =>
        fs
          .readdirSync(path.join(releaseDir, d))
          .filter((e) => e.endsWith('.app'))
          .map((e) => path.join(releaseDir, d, e))
      )
  : [];

if (apps.length === 0) {
  console.error(`[verify-mac-signature] no .app found under ${releaseDir}/mac*/ — nothing to verify`);
  process.exit(1);
}

let failed = false;
for (const app of apps) {
  console.log(`[verify-mac-signature] verifying ${app}`);
  // --deep --strict is the right call for VERIFYING (unlike signing, where Apple discourages --deep):
  // it walks every nested helper, framework and .node addon rather than just the outer bundle.
  const res = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], {
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    console.error(`[verify-mac-signature] INVALID signature: ${app}`);
    failed = true;
    continue;
  }
  // Print the signing authority / CDHash for the build log. `codesign --display` writes to stderr,
  // so let it inherit rather than trying to capture stdout (which is empty).
  spawnSync('codesign', ['--display', '--verbose=4', app], { stdio: 'inherit' });
}

if (failed) {
  console.error(
    '[verify-mac-signature] FAILED — the dmg would install an app macOS calls "damaged". ' +
      'Check that electronFuses are flipped BEFORE signing and that mac.identity is set.'
  );
  process.exit(1);
}
console.log('[verify-mac-signature] OK');
