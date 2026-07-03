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
const https = require('node:https');

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

function mkdirp(dir) { fs.mkdirSync(dir, { recursive: true }); }

function copyWasm() {
  // Resolve the installed package's wasm/ dir (works with npm workspaces hoisting to root node_modules).
  let pkgDir;
  try { pkgDir = path.dirname(require.resolve('@mediapipe/tasks-vision/package.json', { paths: [ROOT] })); }
  catch { console.error('[mediapipe] @mediapipe/tasks-vision not installed — run `npm install` first.'); process.exit(1); }
  const wasmSrc = path.join(pkgDir, 'wasm');
  if (!fs.existsSync(wasmSrc)) { console.error(`[mediapipe] no wasm/ dir in ${pkgDir}`); process.exit(1); }
  mkdirp(WASM_OUT);
  let n = 0;
  for (const f of fs.readdirSync(wasmSrc)) {
    const dst = path.join(WASM_OUT, f);
    if (fs.existsSync(dst)) continue;
    fs.copyFileSync(path.join(wasmSrc, f), dst); n++;
  }
  console.log(`[mediapipe] wasm: ${n} file(s) copied → ${path.relative(ROOT, WASM_OUT)} (${fs.readdirSync(WASM_OUT).length} total)`);
}

function download(url, dst) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dst);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.rmSync(dst, { force: true });
        return download(res.headers.location, dst).then(resolve, reject);
      }
      if (res.statusCode !== 200) { file.close(); fs.rmSync(dst, { force: true }); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });
    req.on('error', (e) => { file.close(); fs.rmSync(dst, { force: true }); reject(e); });
  });
}

async function fetchModels() {
  mkdirp(MODEL_OUT);
  for (const m of MODELS) {
    const dst = path.join(MODEL_OUT, m.name);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) { console.log(`[mediapipe] model: ${m.name} already present — skipped`); continue; }
    process.stdout.write(`[mediapipe] model: downloading ${m.name}… `);
    await download(m.url, dst);
    console.log(`done (${(fs.statSync(dst).size / 1e6).toFixed(1)} MB)`);
  }
}

(async () => {
  mkdirp(OUT);
  copyWasm();
  await fetchModels();
  console.log('[mediapipe] assets ready.');
})().catch((e) => { console.error('[mediapipe] asset fetch failed:', e.message); process.exit(1); });
