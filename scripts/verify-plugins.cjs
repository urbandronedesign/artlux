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
  // The zone occupancy store is a SINGLETON with latched state: the plugin's per-frame evaluate()
  // writes it and the FSM's trigger reads it. Duplicate the module and the writer fills one copy
  // while the show machine questions an empty other — zones would simply never fire, silently.
  { plugin: 'lidar-tracking', where: 'renderer', marker: 'zones] subscriber',    note: 'trigger-zone occupancy store' },
  { plugin: 'calibration',    where: 'renderer', marker: 'calib:camera-open',    note: 'calibCapture native channel' },
  { plugin: 'ndi',            where: 'renderer', marker: 'ndi:configure',        note: 'ndiReceiver plugin-IPC channel' },
  { plugin: 'ndi',            where: 'main',     marker: 'NDI_RUNTIME_DIR_V6',   note: 'ndiManager native runtime dir' },
  { plugin: 'calibration',    where: 'main',     marker: 'calib:detect-board',   note: 'calibManager IPC handle' },
  { plugin: 'spout',          where: 'renderer', marker: 'spout:configure',      note: 'spoutReceiver plugin-IPC channel' },
  { plugin: 'spout',          where: 'main',     marker: 'spout] native receiver loaded', note: 'spoutManager native-load log' },
  { plugin: 'hap',            where: 'renderer', marker: 'hap:decode',           note: 'hapDecode plugin-IPC channel' },
  { plugin: 'hap',            where: 'main',     marker: 'hap] native decoder loaded', note: 'hapManager native-load log' },
  { plugin: 'mp4',            where: 'renderer', marker: 'mp4-webcodecs',        note: 'mp4Codec id (renderer-only)' },
  { plugin: 'mediapipe',      where: 'renderer', marker: 'mediapipe] subscriber', note: 'poseStore subscriber log (renderer-only)' },
  { plugin: 'augmenta',       where: 'renderer', marker: 'augmenta] subscriber', note: 'augmentaStore subscriber log (renderer-only)' },
  { plugin: 'show-control',   where: 'renderer', marker: 'showctl:command',      note: 'command intake channel (plugin.renderer)' },
  { plugin: 'show-control',   where: 'main',     marker: '[show-control] tablet server at', note: 'server listen log (main)' },
];

// Contribution-coverage: distinctive strings proving a plugin still REGISTERS a given contribution into
// a host registry. Unlike CHECKS (which assert single module identity == 1), these assert PRESENCE
// (>= 1 across the renderer bundle) — they catch a plugin silently dropping a UI contribution (a
// settings section / panel that stops being registered but still builds). Use value strings (not object
// keys) that survive minification. Add one line per contribution worth guarding.
const CONTRIBUTIONS = [
  { plugin: 'lidar-tracking', marker: 'osc-monitor',    note: 'OSC Monitor — modal PanelContribution id (panelRegistry)' },
  { plugin: 'lidar-tracking', marker: 'OSC Monitor',    note: 'OSC Monitor — panel body shipped' },
  { plugin: 'lidar-tracking', marker: 'zone-editor',    note: 'Trigger Zones — dock PanelContribution id (panelRegistry)' },
  { plugin: 'lidar-tracking', marker: 'lidar.zone',     note: 'zone trigger — SmTriggerContribution source (smTriggerRegistry)' },
  { plugin: 'mp4',            marker: 'GPU MP4 decode',  note: 'Video — SettingsSection (settingsSectionRegistry)' },
  { plugin: 'mediapipe',      marker: 'pose-monitor',    note: 'Pose Monitor — modal PanelContribution id (panelRegistry)' },
  { plugin: 'mediapipe',      marker: 'pose-calibrate',  note: 'Pose Floor Calibration — modal PanelContribution id (panelRegistry)' },
  { plugin: 'mediapipe',      marker: 'Pose Tracking (MediaPipe)', note: 'Pose Tracking — SettingsSection (settingsSectionRegistry)' },
  { plugin: 'augmenta',       marker: 'augmenta-monitor',   note: 'Augmenta Monitor — modal PanelContribution id (panelRegistry)' },
  { plugin: 'augmenta',       marker: 'Augmenta Tracking',  note: 'Augmenta Tracking — SettingsSection (settingsSectionRegistry)' },
  { plugin: 'show-control',   marker: 'Show Control',       note: 'Show Control — SettingsSection + operator panel (renderer)' },
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

  // Contribution-coverage: each marker must appear at least once across the renderer chunks.
  for (const c of CONTRIBUTIONS) {
    const hits = chunks.filter((k) => k.text.includes(c.marker)).length;
    if (hits >= 1) ok(`[${c.plugin}] contribution "${c.marker}" — present (${hits} chunk${hits > 1 ? 's' : ''}) — ${c.note}`);
    else { failures++; fail(`[${c.plugin}] contribution "${c.marker}" — MISSING from the renderer bundle (contribution dropped, or the marker changed) — ${c.note}`); }
  }

  console.log('');
  if (failures) { console.error(`\x1b[31mplugin verification: ${failures} failure(s)\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32mplugin verification OK (${CHECKS.length} identity + ${CONTRIBUTIONS.length} contribution markers)\x1b[0m`);
}

main();
