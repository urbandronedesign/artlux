// Copies the built Rust cdylib into a loadable .node addon.
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'native', 'output-engine');
const candidates = [
  path.join(dir, 'target', 'release', 'artlux_output_engine.dll'),     // Windows
  path.join(dir, 'target', 'release', 'libartlux_output_engine.so'),   // Linux
  path.join(dir, 'target', 'release', 'libartlux_output_engine.dylib'),// macOS
];
const src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  console.error('[copy-native] no built library found; run cargo build --release first');
  process.exit(1);
}
const dest = path.join(dir, 'output-engine.node');
fs.copyFileSync(src, dest);
console.log(`[copy-native] ${path.basename(src)} -> ${path.relative(process.cwd(), dest)}`);
