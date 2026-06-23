// Copies the freshly built REAL NDI addon to the committed prebuilt native/ndi/ndi.node.
// Run by `npm run build:ndi` (which builds with --features ndi). Requires the NDI 6 SDK +
// LLVM at build time; the resulting ndi.node is committed so CI + end users don't need the
// SDK (only the free NDI Runtime at runtime). Re-run + commit when native/ndi/src changes.
const fs = require('node:fs');
const path = require('node:path');

const base = path.join(__dirname, '..', 'native', 'ndi');
const candidates = [
  path.join(base, 'target', 'release', 'artlux_ndi.dll'),       // Windows
  path.join(base, 'target', 'release', 'libartlux_ndi.so'),     // Linux
  path.join(base, 'target', 'release', 'libartlux_ndi.dylib'),  // macOS
];
const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error('[copy-ndi] no built NDI library found; run cargo build --features ndi first');
  process.exit(1);
}
const dest = path.join(base, 'ndi.node');
fs.copyFileSync(src, dest);
console.log(`[copy-ndi] ${path.basename(src)} -> ${path.relative(process.cwd(), dest)}`);
