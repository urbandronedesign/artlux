#!/usr/bin/env node
/*
 * Plugin single-identity verifier.
 *
 * The plugin architecture's #1 invariant (docs/PLUGINS.md → "the barrel rule"): a plugin's runtime
 * singletons must have exactly ONE module identity per window bundle. The bug it guards against: if
 * host code deep-imports a plugin module through the package alias (`@artlux/plugin-x/foo`) while the
 * plugin's own files import it relatively (`./foo`), Vite/Rollup treat the two specifiers as separate
 * modules and DUPLICATE the singleton — writers touch one copy, readers see the empty other. We hit
 * this for real with `trackingStore` (3D view had blobs, projector got none).
 *
 * After every plugin change we grepped the built bundles by hand to confirm each singleton appears
 * once. This script automates that: each marker below is a string literal unique to one plugin
 * singleton module. In the code-split renderer output it must live in exactly ONE chunk file (a marker
 * in 2+ chunks == a duplicated module); the main process bundles to a single file, so there we assert
 * the marker occurs exactly once (catches accidental double-bundling).
 *
 * Run AFTER `npm run build` (it inspects out/, it does not build). Wired as `npm run verify:plugins`.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'out', 'renderer', 'assets');
const MAIN_BUNDLE = path.join(ROOT, 'out', 'main', 'index.js');

// Each check: a string literal unique to one plugin singleton module, and where it should live.
//   where: 'renderer' → must appear in exactly one renderer chunk file (code-split output).
//   where: 'main'     → single bundle; must occur exactly `occurrences` times (default 1).
const CHECKS = [
  { plugin: 'lidar-tracking', where: 'renderer', marker: 'tracking] subscriber', note: 'trackingStore subscriber log' },
  { plugin: 'calibration',    where: 'renderer', marker: 'calib:camera-open',    note: 'calibCapture native channel' },
  { plugin: 'ndi',            where: 'renderer', marker: 'ndi:configure',        note: 'ndiReceiver plugin-IPC channel' },
  { plugin: 'ndi',            where: 'main',     marker: 'NDI_RUNTIME_DIR_V6',   note: 'ndiManager native runtime dir' },
  { plugin: 'calibration',    where: 'main',     marker: 'calib:detect-board',   note: 'calibManager IPC handle' },
  { plugin: 'spout',          where: 'renderer', marker: 'spout:configure',      note: 'spoutReceiver plugin-IPC channel' },
  { plugin: 'spout',          where: 'main',     marker: 'spout] native receiver loaded', note: 'spoutManager native-load log' },
];

function fail(msg) { console.error(`\x1b[31m✗\x1b[0m ${msg}`); }
function ok(msg) { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }

function loadRendererChunks() {
  if (!fs.existsSync(RENDERER_DIR)) return null;
  return fs.readdirSync(RENDERER_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: `out/renderer/assets/${f}`, text: fs.readFileSync(path.join(RENDERER_DIR, f), 'utf8') }));
}

function occurrences(text, marker) {
  let n = 0, i = 0;
  for (;;) {
    const at = text.indexOf(marker, i);
    if (at === -1) return n;
    n++; i = at + marker.length;
  }
}

function main() {
  const chunks = loadRendererChunks();
  const mainText = fs.existsSync(MAIN_BUNDLE) ? fs.readFileSync(MAIN_BUNDLE, 'utf8') : null;
  if (!chunks || !mainText) {
    console.error('Build output missing (out/renderer/assets or out/main/index.js). Run `npm run build` first.');
    process.exit(2);
  }

  let failures = 0;
  for (const c of CHECKS) {
    if (c.where === 'renderer') {
      const hits = chunks.filter((k) => k.text.includes(c.marker));
      if (hits.length === 1) {
        ok(`[${c.plugin}] "${c.marker}" — 1 chunk (${path.basename(hits[0].file)}) — ${c.note}`);
      } else if (hits.length === 0) {
        failures++; fail(`[${c.plugin}] "${c.marker}" — NOT FOUND in any renderer chunk (stale build, or the marker string changed) — ${c.note}`);
      } else {
        failures++; fail(`[${c.plugin}] "${c.marker}" — DUPLICATED across ${hits.length} chunks: ${hits.map((h) => path.basename(h.file)).join(', ')} — module split (barrel rule) — ${c.note}`);
      }
    } else {
      const n = occurrences(mainText, c.marker);
      const want = c.occurrences ?? 1;
      if (n === want) ok(`[${c.plugin}] "${c.marker}" — ${n}× in main — ${c.note}`);
      else if (n === 0) { failures++; fail(`[${c.plugin}] "${c.marker}" — NOT FOUND in out/main/index.js (stale build, or the marker changed) — ${c.note}`); }
      else { failures++; fail(`[${c.plugin}] "${c.marker}" — ${n}× in main (want ${want}) — possible double-bundling — ${c.note}`); }
    }
  }

  console.log('');
  if (failures) { console.error(`\x1b[31mplugin single-identity: ${failures} failure(s)\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32mplugin single-identity OK (${CHECKS.length} markers)\x1b[0m`);
}

main();
