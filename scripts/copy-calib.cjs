// Copies the freshly built native projector-calibration addon to the committed prebuilt
// native/calib/calib.node. Run by `npm run build:calib`. Requires system OpenCV (with the
// structured_light contrib module) + LLVM/libclang at build time (the `opencv` crate uses bindgen);
// the resulting calib.node is committed so CI + end users don't need OpenCV (NDI precedent). Re-run +
// commit when native/calib/src changes.
const fs = require('node:fs');
const path = require('node:path');

const base = path.join(__dirname, '..', 'native', 'calib');
const candidates = [
  path.join(base, 'target', 'release', 'artlux_calib.dll'),       // Windows
  path.join(base, 'target', 'release', 'libartlux_calib.so'),     // Linux
  path.join(base, 'target', 'release', 'libartlux_calib.dylib'),  // macOS
];
const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error('[copy-calib] no built calibration library found; run cargo build --release (with OpenCV+LLVM) first');
  process.exit(1);
}
const dest = path.join(base, 'calib.node');
fs.copyFileSync(src, dest);
console.log(`[copy-calib] ${path.basename(src)} -> ${path.relative(process.cwd(), dest)}`);
