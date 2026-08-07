#!/usr/bin/env node
// Populate the offline MediaPipe assets the pose-tracking plugin loads at runtime.
//
// @mediapipe/tasks-vision would otherwise fetch its WASM fileset + the .task model from a Google CDN
// per session — which fails under Electron's offline/CSP posture. Instead we stage everything locally
// under the renderer public dir (src/renderer/public/mediapipe/), so Vite serves it at /mediapipe/ in
// dev and copies it into out/renderer/ for packaged builds (bundled by electron-builder via files:).
//
//   • wasm/   — copied from the installed @mediapipe/tasks-vision package (ships the WASM runtime)
//   • models/ — the BlazePose pose_landmarker_{lite,full,heavy}.task files, downloaded once
//
// Run:  npm run assets:mediapipe   (after `npm install`). Idempotent — skips files already present.

const fs = require('node:fs');
const path = require('node:path');
const { download, fail } = require('./lib/download.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'renderer', 'public', 'mediapipe');
const WASM_OUT = path.join(OUT, 'wasm');
const MODEL_OUT = path.join(OUT, 'models');

// The MediaPipe model storage bucket (public). Pin to the storage path the docs use.
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';
const MODELS = [
  { name: 'pose_landmarker_lite.task', url: `${MODEL_BASE}/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task` },
  { name: 'pose_landmarker_full.task', url: `${MODEL_BASE}/pose_landmarker_full/float16/latest/pose_landmarker_full.task` },
  { name: 'pose_landmarker_heavy.task', url: `${MODEL_BASE}/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task` },
];
// The smallest model (lite) is ~5 MB. This is a floor for "did we get a model or an error page", and it
// is ALSO the skip threshold: this script used to pipe straight to the destination path and skip on
// `size > 0`, so one dropped connection left a truncated .task file that every later run accepted. Any
// model on disk under this size is assumed to be such a carcass and re-fetched.
const MODEL_MIN_BYTES = 1024 * 1024;

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

function copyWasm() {
  // Resolve the installed package's wasm/ dir (works with npm workspaces hoisting to root node_modules).
  // The package ships an `exports` map that does NOT expose ./package.json, so resolving that path throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED — resolve an *exported* wasm subpath instead and walk up from it.
  let wasmSrc;
  try { wasmSrc = path.dirname(require.resolve('@mediapipe/tasks-vision/vision_wasm_internal.js', { paths: [ROOT] })); }
  catch {
    // Older/looser packagings: fall back to the package root, then its wasm/ dir.
    try { wasmSrc = path.join(path.dirname(require.resolve('@mediapipe/tasks-vision/package.json', { paths: [ROOT] })), 'wasm'); }
    // Thrown, not process.exit(1): these run inside the async IIFE below, whose catch reports through
    // fail() — and on Windows a console.error immediately followed by process.exit can lose the message
    // entirely, because stderr to a pipe is asynchronous there.
    catch { throw new Error('@mediapipe/tasks-vision not installed — run `npm install` first.'); }
  }
  if (!fs.existsSync(wasmSrc)) throw new Error(`no wasm/ dir at ${wasmSrc}`);
  mkdirp(WASM_OUT);
  let n = 0;
  for (const f of fs.readdirSync(wasmSrc)) {
    const dst = path.join(WASM_OUT, f);
    if (fs.existsSync(dst)) continue;
    fs.copyFileSync(path.join(wasmSrc, f), dst); n++;
  }
  console.log(`[mediapipe] wasm: ${n} file(s) copied → ${path.relative(ROOT, WASM_OUT)} (${fs.readdirSync(WASM_OUT).length} total)`);
}

async function fetchModels() {
  mkdirp(MODEL_OUT);
  for (const m of MODELS) {
    const dst = path.join(MODEL_OUT, m.name);
    if (fs.existsSync(dst) && fs.statSync(dst).size >= MODEL_MIN_BYTES) {
      console.log(`[mediapipe] model: ${m.name} already present — skipped (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
      continue;
    }
    console.log(`[mediapipe] model: downloading ${m.name}…`);
    const size = await download(m.url, dst, { label: 'mediapipe', minBytes: MODEL_MIN_BYTES });
    console.log(`[mediapipe] model: ${m.name} done (${(size / 1e6).toFixed(1)} MB)`);
  }
}

(async () => {
  mkdirp(OUT);
  copyWasm();
  await fetchModels();
  console.log('[mediapipe] assets ready.');
})().catch((e) => fail('[mediapipe] asset fetch failed:', e));
