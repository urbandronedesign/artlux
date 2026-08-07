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
 *
 * The download itself lives in scripts/lib/download.cjs — read its header before touching it. This
 * script is where the silent-exit-0 bug was found: it reported success having written nothing, and
 * only `verify:resources` stood between that and an installer with no VC++ runtime in it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { download, fail } = require('./lib/download.cjs');

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

(async () => {
  for (const r of REDISTS) {
    if (fs.existsSync(r.dst) && fs.statSync(r.dst).size >= r.minBytes) {
      console.log(`[redist] ${r.name}: already present — skipped (${(fs.statSync(r.dst).size / 1e6).toFixed(1)} MB)`);
      continue;
    }
    // One complete line per event, never a dangling `process.stdout.write` with no newline: the partial
    // line is what made the failing build ambiguous to read, because the runner's log only flushed it
    // when the NEXT process printed, stamping the two with the same timestamp.
    console.log(`[redist] ${r.name}: downloading…`);
    const size = await download(r.url, r.dst, { label: 'redist', minBytes: r.minBytes });
    console.log(`[redist] ${r.name}: done (${(size / 1e6).toFixed(1)} MB) → ${path.relative(ROOT, r.dst)}`);
  }
  console.log('[redist] redistributables ready.');
})().catch((e) => fail('[redist] fetch failed:', e));
