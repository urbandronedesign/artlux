// Copies built Rust cdylibs into loadable .node addons.
const fs = require('node:fs');
const path = require('node:path');

// Each native crate: its dir under native/, the cargo lib basename, and the
// output .node name. Spout is Windows-only but still produces a stub .node.
const CRATES = [
  { dir: 'output-engine', lib: 'artlux_output_engine', out: 'output-engine.node', required: true },
  { dir: 'spout-receiver', lib: 'artlux_spout_receiver', out: 'spout-receiver.node', required: false },
  { dir: 'ndi', lib: 'artlux_ndi', out: 'ndi.node', required: false },
];

let copied = 0;
for (const c of CRATES) {
  const base = path.join(__dirname, '..', 'native', c.dir);
  const candidates = [
    path.join(base, 'target', 'release', `${c.lib}.dll`),      // Windows
    path.join(base, 'target', 'release', `lib${c.lib}.so`),    // Linux
    path.join(base, 'target', 'release', `lib${c.lib}.dylib`), // macOS
  ];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) {
    const msg = `[copy-native] ${c.dir}: no built library found`;
    if (c.required) { console.error(`${msg}; run cargo build --release first`); process.exit(1); }
    console.warn(`${msg} (skipping — optional)`);
    continue;
  }
  const dest = path.join(base, c.out);
  fs.copyFileSync(src, dest);
  console.log(`[copy-native] ${path.basename(src)} -> ${path.relative(process.cwd(), dest)}`);
  copied++;
}
if (!copied) process.exit(1);
