// electron-builder afterPack hook: ad-hoc-sign the macOS .app so it is executable
// on Apple Silicon (an unsigned Mach-O won't run). We have no Apple Developer ID,
// so this is NOT notarized — downloaded dmgs still need a one-time Gatekeeper
// bypass (right-click → Open, or `xattr -dr com.apple.quarantine <app>`). No-op
// on Windows/Linux runners.
//
// ⚠ SIGNED INSIDE-OUT, NOT WITH `--deep`.
// This used to be a single `codesign --deep --sign - <app>`. That is deprecated by Apple and is
// unreliable for nested code: `--deep` walks what it recognises as a bundle, and a framework dropped
// in by electron-builder's `extraFiles` (Contents/Frameworks/Syphon.framework) plus loose `.node`
// addons in Contents/Resources are exactly the cases it handles worst. The failure mode is nasty
// because it is not a warning: on Apple Silicon a wrongly-signed Mach-O does not load AT ALL, and
// the app then reports "[syphon] native receiver unavailable" — which reads precisely like a missing
// build rather than a broken signature, sending you to rebuild something that was fine.
//
// So: sign every nested binary first, innermost outward, then the app itself last. Signing an outer
// bundle invalidates nothing below it, but signing an inner one AFTER the outer does invalidate the
// outer — hence the order.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], { stdio: 'inherit' });
}

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const contents = path.join(app, 'Contents');

  // 1. Frameworks we dropped in ourselves. Electron's own frameworks are already signed by the
  //    packager; re-signing them is harmless but pointless, so only take what we put there.
  const frameworks = path.join(contents, 'Frameworks');
  for (const name of fs.existsSync(frameworks) ? fs.readdirSync(frameworks) : []) {
    if (name === 'Syphon.framework') {
      console.log(`[mac-adhoc-sign] framework ${name}`);
      sign(path.join(frameworks, name));
    }
  }

  // 2. Native addons. They live loose in Contents/Resources (extraResources), so nothing walks to
  //    them automatically — each is an independent Mach-O that must carry its own signature.
  const resources = path.join(contents, 'Resources');
  for (const name of fs.existsSync(resources) ? fs.readdirSync(resources) : []) {
    if (name.endsWith('.node')) {
      console.log(`[mac-adhoc-sign] addon ${name}`);
      sign(path.join(resources, name));
    }
  }

  // 3. The app last, so nothing signed above invalidates it.
  console.log(`[mac-adhoc-sign] ad-hoc signing ${app}`);
  sign(app);

  // 4. Assert it. `codesign --verify --strict` is the difference between "we ran codesign" and "the
  //    result is loadable" — and this hook's whole job is the latter.
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
