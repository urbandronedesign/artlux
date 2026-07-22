#!/usr/bin/env node
/*
 * Stage the Windows redistributables the NSIS installer bundles and silently installs.
 *
 * Why the installer carries them at all: a fresh venue PC has neither, and both failures are SILENT.
 *   • NDI Runtime — `ndi.node` is a committed prebuilt and loads fine, then `runtimeAvailable()`
 *     returns false (it links Processing.NDI.Lib.x64.dll, which the runtime provides) and NDI simply
 *     disappears from the UI with one line in a console nobody is watching. This is the exact failure
 *     we hit installing on a second machine.
 *   • VC++ 2015-2022 x64 — every MSVC-built addon (all six .node files) and opencv_world4110.dll link
 *     the dynamic CRT. Without it `require()` throws and the feature degrades to a no-op.
 *
 * Why they are downloaded rather than committed: ~50 MB of unmodified third-party binaries would bloat
 * git history permanently and again on every version bump — the same reasoning `.gitignore` already
 * applies to opencv_world4110.dll. Both URLs below are vendor-permanent redirects, so CI and a local
 * `npm run package` fetch the current build. Output lands in gitignored build/ subdirs.
 *
 * NDI redistribution is permitted under the NDI SDK licence provided the attribution and trademark
 * notice are kept — see NOTICE.
 *
 * Run:  npm run fetch:redist        (idempotent — skips files already present and non-empty)
 * CI:   a step before `electron-builder`; `scripts/verify-package-resources.cjs` then hard-fails the
 *       package if either file is somehow still absent.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');

const REDISTS = [
  {
    name: 'NDI Runtime',
    // NDI's own permanent short-link for the v6 redistributable (documented in the NDI SDK's
    // "Redistribution" section). Redirects to downloads.ndi.tv.
    url: 'https://ndi.link/NDIRedistV6',
    dst: path.join(ROOT, 'build', 'ndi', 'NDI-Runtime.exe'),
    minBytes: 5 * 1024 * 1024,
  },
  {
    name: 'VC++ 2015-2022 x64 redistributable',
    // Microsoft's evergreen link for the latest VS2015-2022 x64 runtime.
    url: 'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    dst: path.join(ROOT, 'build', 'vcredist', 'vc_redist.x64.exe'),
    minBytes: 5 * 1024 * 1024,
  },
];

// Follows redirects across BOTH schemes — aka.ms and ndi.link both bounce through http/https hops, so a
// bare https.get (as in fetch-mediapipe-assets.cjs, whose URLs are single-scheme) would throw here.
function download(url, dst, depth = 0) {
  if (depth > 10) return Promise.reject(new Error(`too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, { headers: { 'user-agent': 'artlux-build' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain, or the socket stays open
        const next = new URL(res.headers.location, url).toString();
        return download(next, dst, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      // Write to a .part file and rename only on success, so an interrupted download can never leave a
      // truncated binary that existsSync() would happily accept next run.
      const tmp = `${dst}.part`;
      const file = fs.createWriteStream(tmp);
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(tmp, dst); resolve(); }));
      file.on('error', (e) => { fs.rmSync(tmp, { force: true }); reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

(async () => {
  for (const r of REDISTS) {
    if (fs.existsSync(r.dst) && fs.statSync(r.dst).size >= r.minBytes) {
      console.log(`[redist] ${r.name}: already present — skipped (${(fs.statSync(r.dst).size / 1e6).toFixed(1)} MB)`);
      continue;
    }
    fs.mkdirSync(path.dirname(r.dst), { recursive: true });
    process.stdout.write(`[redist] ${r.name}: downloading… `);
    await download(r.url, r.dst);
    const size = fs.statSync(r.dst).size;
    if (size < r.minBytes) throw new Error(`${r.name} downloaded only ${size} bytes — the URL likely served an error page`);
    console.log(`done (${(size / 1e6).toFixed(1)} MB) → ${path.relative(ROOT, r.dst)}`);
  }
  console.log('[redist] redistributables ready.');
})().catch((e) => { console.error('[redist] fetch failed:', e.message); process.exit(1); });
