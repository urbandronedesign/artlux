// Copies the freshly built native NVAPI warp/blend addon to the committed prebuilt
// native/nvwarp/nvwarp.node. Run by `npm run build:nvwarp`. Builds as a graceful stub when the NVAPI
// SDK is absent (NVAPI_SDK_DIR unset); set NVAPI_SDK_DIR on a Quadro/RTX-pro machine for the real path.
const fs = require('node:fs');
const path = require('node:path');

const base = path.join(__dirname, '..', 'native', 'nvwarp');
const candidates = [
  path.join(base, 'target', 'release', 'artlux_nvwarp.dll'),       // Windows
  path.join(base, 'target', 'release', 'libartlux_nvwarp.so'),     // Linux (stub only)
  path.join(base, 'target', 'release', 'libartlux_nvwarp.dylib'),  // macOS (stub only)
];
const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error('[copy-nvwarp] no built nvwarp library found; run cargo build --release first');
  process.exit(1);
}
const dest = path.join(base, 'nvwarp.node');
fs.copyFileSync(src, dest);
console.log(`[copy-nvwarp] ${path.basename(src)} -> ${path.relative(process.cwd(), dest)}`);
