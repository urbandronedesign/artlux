// electron-builder afterPack hook: ad-hoc-sign the macOS .app so it is executable
// on Apple Silicon (an unsigned Mach-O won't run). We have no Apple Developer ID,
// so this is NOT notarized — downloaded dmgs still need a one-time Gatekeeper
// bypass (right-click → Open, or `xattr -dr com.apple.quarantine <app>`). No-op
// on Windows/Linux runners.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  console.log(`[mac-adhoc-sign] ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
};
