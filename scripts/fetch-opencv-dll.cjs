#!/usr/bin/env node
/*
 * Stage native/calib/opencv_world4110.dll — the runtime dependency of the committed calib.node prebuilt.
 *
 * The gap this closes: `calib.node` IS committed (small, ours), but the 62 MB stock OpenCV world DLL is
 * deliberately gitignored (`.gitignore` → `native/calib/*.dll`) to keep it out of history. It normally
 * arrives via `npm run build:calib`, which needs OpenCV + LLVM + MSVC on the host — a toolchain CI does
 * not have and never installs (`.github/workflows/build.yml` runs build:native only). So on every CI
 * runner the DLL did not exist, electron-builder silently skipped its extraResources entry (a `from`
 * path is a GLOB — matching nothing is not an error), and every published installer shipped calib.node
 * with no OpenCV behind it. The user-visible symptom is one console line: `[calib] native OpenCV addon
 * unavailable (calibration disabled)`.
 *
 * This fetches the stock DLL directly from the official OpenCV release, with no OpenCV/LLVM/MSVC
 * toolchain required — it is an unmodified redistributable, so nothing needs to be *built* to obtain
 * it. Building calib.node itself still needs build:calib; this only supplies its runtime.
 *
 * The Windows release asset is a 7-Zip self-extracting archive. We prefer `7z` (present on the GitHub
 * windows runners and most dev boxes) to pull the single file out without unpacking ~1 GB; if 7z is
 * absent we fall back to running the SFX itself, which accepts 7-Zip's -o/-y flags.
 *
 * Run:  npm run fetch:opencv     (idempotent — skips if the DLL is already beside calib.node)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Pinned to the version native/calib/calib.node was linked against — build-calib.ps1 auto-detects the
// versioned world lib, so if calib.node is ever rebuilt against a newer OpenCV, bump BOTH this and the
// package.json extraResources entry (the DLL name is version-stamped: opencv_world4110.dll).
const OPENCV_VERSION = '4.11.0';
const DLL_NAME = 'opencv_world4110.dll';
const SFX_URL = `https://github.com/opencv/opencv/releases/download/${OPENCV_VERSION}/opencv-${OPENCV_VERSION}-windows.exe`;
// Path of the DLL *inside* the archive (matches the layout build-calib.ps1 expects: build\x64\vc16\bin).
const MEMBER = `opencv/build/x64/vc16/bin/${DLL_NAME}`;

const DST_DIR = path.join(ROOT, 'native', 'calib');
const DST = path.join(DST_DIR, DLL_NAME);
const MIN_BYTES = 20 * 1024 * 1024; // the real DLL is ~62 MB; anything tiny is an error page

function download(url, dst, depth = 0) {
  if (depth > 10) return Promise.reject(new Error(`too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'artlux-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), dst, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const total = Number(res.headers['content-length'] || 0);
      let seen = 0, lastPct = -1;
      const tmp = `${dst}.part`;
      const file = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        seen += c.length;
        if (!total) return;
        const pct = Math.floor((seen / total) * 100);
        if (pct !== lastPct && pct % 10 === 0) { lastPct = pct; process.stdout.write(`${pct}% `); }
      });
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dst); resolve(); }));
      file.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(300_000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

// No `shell: true` anywhere below: it triggers Node's DEP0190 warning and concatenates args unescaped,
// and it is not needed — CreateProcess appends `.exe` itself, so a bare `7z` resolves fine on Windows.
function has7z() {
  const r = spawnSync('7z', ['i'], { stdio: 'ignore' });
  return r.status === 0;
}

// Extract just the one member. `7z e` flattens the path, giving us the DLL directly in outDir.
function extractWith7z(sfx, outDir) {
  const r = spawnSync('7z', ['e', sfx, MEMBER, `-o${outDir}`, '-y'], { stdio: 'inherit' });
  return r.status === 0 && fs.existsSync(path.join(outDir, DLL_NAME));
}

// Fallback: the SFX is a 7-Zip installer stub and honours -o<dir> -y. Unpacks everything (~1 GB), so
// we do it in a temp dir and delete it afterwards.
function extractWithSfx(sfx, outDir) {
  if (process.platform !== 'win32') return false;
  const r = spawnSync(sfx, [`-o${outDir}`, '-y'], { stdio: 'inherit' });
  if (r.status !== 0) return false;
  const found = path.join(outDir, 'opencv', 'build', 'x64', 'vc16', 'bin', DLL_NAME);
  if (!fs.existsSync(found)) return false;
  fs.copyFileSync(found, path.join(outDir, DLL_NAME));
  return true;
}

(async () => {
  if (fs.existsSync(DST) && fs.statSync(DST).size >= MIN_BYTES) {
    console.log(`[opencv] ${DLL_NAME}: already present — skipped (${(fs.statSync(DST).size / 1e6).toFixed(1)} MB)`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'artlux-opencv-'));
  const sfx = path.join(work, `opencv-${OPENCV_VERSION}-windows.exe`);
  try {
    process.stdout.write(`[opencv] downloading opencv-${OPENCV_VERSION}-windows.exe … `);
    await download(SFX_URL, sfx);
    console.log(`done (${(fs.statSync(sfx).size / 1e6).toFixed(0)} MB)`);

    console.log('[opencv] extracting…');
    const okExtract = (has7z() && extractWith7z(sfx, work)) || extractWithSfx(sfx, work);
    if (!okExtract) {
      throw new Error(
        'could not extract the DLL.\n' +
        '  Install 7-Zip (https://www.7-zip.org/) and re-run, or extract the archive manually and copy\n' +
        `  opencv/build/x64/vc16/bin/${DLL_NAME} to native/calib/.`,
      );
    }

    const src = path.join(work, DLL_NAME);
    const size = fs.statSync(src).size;
    if (size < MIN_BYTES) throw new Error(`extracted ${DLL_NAME} is only ${size} bytes — extraction went wrong`);
    fs.mkdirSync(DST_DIR, { recursive: true });
    fs.copyFileSync(src, DST);
    console.log(`[opencv] ${DLL_NAME} → native/calib/ (${(size / 1e6).toFixed(1)} MB)`);
  } finally {
    // ~1 GB in the SFX-fallback case — always clean up.
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
})().catch((e) => { console.error('[opencv] fetch failed:', e.message); process.exit(1); });
