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
// electron-builder emits release/mac-arm64/ArtLux.app (or release/mac/ for x64) — and, for the suite's
// two products (scripts/package-app.cjs), the same under release/show/ and release/calibrator/. Every
// .app found is checked: a release ships both, and either one being unopenable is a failed release.
const roots = [releaseDir, path.join(releaseDir, 'show'), path.join(releaseDir, 'calibrator')].filter((r) => fs.existsSync(r));
const apps = roots.flatMap((root) =>
  fs
    .readdirSync(root)
    .filter((d) => d === 'mac' || d.startsWith('mac-'))
    .flatMap((d) =>
      fs
        .readdirSync(path.join(root, d))
        .filter((e) => e.endsWith('.app'))
        .map((e) => path.join(root, d, e))
    )
);

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

// ── NO BINARY MAY ASK FOR A NEWER macOS THAN ELECTRON ITSELF ─────────────────────────────────────
// A signature can be perfect and the app still half-dead: every Mach-O records the oldest macOS it
// will load on (LC_BUILD_VERSION minos), and a build with no deployment target stamps the RUNNER's
// version. The v0.35.0 audio engine said "minos 26.0" — on macOS 13 dlopen refused it, the plugin
// degraded gracefully, and the app played no sound with nothing on screen to say why. The floor is
// read from the Electron binary rather than typed here, so an Electron upgrade moves it by itself.
const ver = (v) => `${v >>> 16}.${(v >> 8) & 255}`;
// Each Mach-O slice's minos (fat binaries carry one per architecture), or [] for a non-Mach-O file.
function minosOf(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(4);
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const fat = head.readUInt32BE(0) === 0xcafebabe;
  if (!fat && head.readUInt32LE(0) !== 0xfeedfacf) return [];
  const b = fs.readFileSync(file);
  const offsets = fat
    ? Array.from({ length: b.readUInt32BE(4) }, (_, i) => b.readUInt32BE(8 + i * 20 + 8))
    : [0];
  return offsets.map((off) => {
    let p = off + 32;
    for (let i = 0, n = b.readUInt32LE(off + 16); i < n; i++) {
      const cmd = b.readUInt32LE(p);
      if (cmd === 0x32) return b.readUInt32LE(p + 12); // LC_BUILD_VERSION
      if (cmd === 0x24) return b.readUInt32LE(p + 8); //  LC_VERSION_MIN_MACOSX (older toolchains)
      p += b.readUInt32LE(p + 4);
    }
    return 0;
  });
}
// The ONE exemption: NDI's own runtime library, which we ship but cannot rebuild — NDI 6 for Apple
// is built for macOS 13. Below that the app still runs and only NDI is unavailable (the ndi plugin
// degrades on a failed load), which docs/NDI.md states. Anything else above the floor is ours.
const EXEMPT = new Set(['libndi.dylib']);
let tooNew = false;
for (const app of apps) {
  const before = tooNew;
  tooNew = false;
  const floor = Math.max(...minosOf(path.join(app, 'Contents', 'MacOS', path.basename(app, '.app'))));
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(f); continue; }
      const worst = Math.max(0, ...minosOf(f));
      if (worst <= floor) continue;
      const rel = path.relative(app, f);
      if (EXEMPT.has(e.name)) { console.log(`[verify-mac-signature] minos ${ver(worst)} allowed: ${rel}`); continue; }
      console.error(`[verify-mac-signature] ${rel} needs macOS ${ver(worst)} — the app itself runs on ${ver(floor)}`);
      tooNew = true;
    }
  };
  walk(app);
  if (!tooNew) console.log(`[verify-mac-signature] ${path.basename(app)}: every binary loads on macOS ${ver(floor)}`);
  tooNew = tooNew || before;
}
if (tooNew) {
  console.error('[verify-mac-signature] FAILED — set a deployment target on the build that made it ' +
    '(CMAKE_OSX_DEPLOYMENT_TARGET / MACOSX_DEPLOYMENT_TARGET), or it will not load on older Macs.');
  process.exit(1);
}
console.log('[verify-mac-signature] OK');
