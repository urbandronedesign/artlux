#!/usr/bin/env node
// Item 2c-1 — MP4 frames: the engine's CONVERSION and STRETCH against the app's, on the app's own decoded
// frames. The page (engine/spikes/mp4-parity) encodes synthetic MP4s, decodes them with the app's REAL
// plugins/mp4 decoder, and dumps each VideoFrame's coded NV12 planes; the engine converts those planes
// (yuv.rs) and draws them (compose.rs). The DECODER is not in this test — the engine's own decoder is held to
// these same planes separately (2c-2), so a difference here is the conversion or the stretch, nothing else.
//
// Two gates:
//   1. THE CONVERSION, 1:1 — the engine's RGB of each frame against Chromium's drawImage(VideoFrame) at its
//      own size: within 1 everywhere, and identical on all but at most 0.5% of channels. Not "identical":
//      Chromium's float arithmetic rounds values within ~0.0075 of a boundary the other way, with no
//      structure to copy (measured — see yuv.rs). Off by more than 1 anywhere = a wrong formula, a wrong
//      chroma siting, or the coded-edge clamp lost.
//   2. THE LEDS — the app's real WebGPUMapper with the VideoFrames as drawables, against the engine's
//      --frame-once on the same rig (strips + a serpentine matrix per picture, one at 60% opacity,
//      brightness 1 and 0.8): within 1 on every LED channel.
//
//   node scripts/test-mp4-parity.cjs [real.mp4 …]      (real files: each on a surface of its own, frame 0)
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const WORK = path.join(os.tmpdir(), 'artlux-mp4-parity');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

// Sizes that are not a multiple of the codec's block (1080 → 1088 coded; 1002×562 → 1008×576 — an odd
// visible width in chroma), H.264 and H.265, sharp / noise / smooth content.
const FILES = [
  { name: 'sharp-avc-1920x1080', kind: 'sharp', w: 1920, h: 1080, codec: 'avc', frames: 3, frame: 1 },
  { name: 'noise-avc-640x360', kind: 'noise', w: 640, h: 360, codec: 'avc', frames: 3, frame: 1 },
  { name: 'photo-avc-1002x562', kind: 'photo', w: 1002, h: 562, codec: 'avc', frames: 3, frame: 2 },
  { name: 'photo-hevc-1280x720', kind: 'photo', w: 1280, h: 720, codec: 'hevc', frames: 3, frame: 1 },
  { name: 'sharp-hevc-854x480', kind: 'sharp', w: 854, h: 480, codec: 'hevc', frames: 2, frame: 0 },
  ...process.argv.slice(2).map((f, i) => ({ name: `extra${i}`, file: path.resolve(f), frame: 0 })),
];

// One surface per file: a horizontal strip, a vertical strip and a serpentine matrix (as test:image-parity).
function rig(names) {
  const surfaces = [], fixtures = [];
  names.forEach((key, k) => {
    const sx = 0.05 + (k % 3) * 0.32, sy = 0.05 + Math.floor(k / 3) * 0.48;
    const sid = `s_${key}`;
    surfaces.push({ id: sid, name: key, x: sx, y: sy, width: 0.28, height: 0.4, rotation: 0, zIndex: k,
      content: { type: 'VIDEO', url: path.join(WORK, `${key}.nv12.json`), ...(k === 2 ? { opacity: 0.6 } : {}) } });
    const base = { rotation: 0, reverse: false, colorData: [], universe: 0, startAddress: 1, surfaceId: sid };
    fixtures.push({ ...base, id: `${sid}_h`, name: `${key} H`, x: sx + 0.01, y: sy + 0.1, width: 0.26, height: 0.004, ledCount: 120 });
    fixtures.push({ ...base, id: `${sid}_v`, name: `${key} V`, x: sx + 0.2, y: sy + 0.01, width: 0.004, height: 0.38, ledCount: 60 });
    fixtures.push({ ...base, id: `${sid}_m`, name: `${key} M`, x: sx + 0.02, y: sy + 0.2, width: 0.2, height: 0.15, ledCount: 32 * 16,
      shape: 'MATRIX', matrixWidth: 32, matrixHeight: 16, serpentine: true });
  });
  return { surfaces, fixtures };
}

// ── the app's side ──────────────────────────────────────────────────────────────────────────────────────
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const pageBundle = path.join(WORK, 'page.js');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'engine', 'spikes', 'mp4-parity', 'page.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: pageBundle, logLevel: 'error',
  // The decoder reaches the host for a media URL; the page registers blob URLs instead (as test:frame-exact).
  alias: { '@/services/mediaCache': path.join(ROOT, 'scripts', 'frame-exact', 'stub-mediacache.ts') }, nodePaths: [path.join(ROOT, 'node_modules')] });
// Jobs are written AFTER we know which files decoded — but the page needs them up front, so every file is
// rigged; a file that did not decode leaves its surface without a drawable (black) on BOTH sides.
const all = rig(FILES.map((f) => f.name));
const jobs = [1, 0.8].map((b) => ({ name: `brightness ${b}`, brightness: b, ...all }));
fs.writeFileSync(path.join(WORK, 'cases.json'), JSON.stringify({ files: FILES, jobs }));
const env = { ...process.env, SPIKE_OUT: WORK, SPIKE_PAGE: pageBundle, SPIKE_ROOT: ROOT };
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  [path.join(ROOT, 'engine', 'spikes', 'sampling-parity')], { env, stdio: 'ignore', timeout: 170000 });
const browser = JSON.parse(fs.readFileSync(path.join(WORK, 'gpu-cases.json'), 'utf8'));
if (browser.error) { console.log(`the page failed: ${browser.error}`); process.exit(1); }

let fails = 0;
const decoded = new Set();
// ── 1. the conversion, 1:1 ──────────────────────────────────────────────────────────────────────────────
console.log('1. THE CONVERSION (1:1, the engine against Chromium\'s drawImage of the VideoFrame)');
for (const f of browser.files) {
  if (f.skipped) { console.log(`  skip ${f.name}: ${f.skipped}`); continue; }
  if (f.error) { fails++; console.log(`  FAIL ${f.name}: ${f.error.split('\n')[0]}`); continue; }
  const out = path.join(WORK, `${f.name}.engine-1to1.bin`);
  try { execFileSync(ENGINE, ['--nv12-convert', path.join(WORK, `${f.name}.nv12.json`), out], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { const why = String(e.stderr || e).trim(); console.log(`  ${/colour space/.test(why) ? 'skip' : 'FAIL'} ${f.name}: ${why}`); if (!/colour space/.test(why)) fails++; continue; }
  decoded.add(f.name);
  const A = fs.readFileSync(path.join(WORK, `${f.name}.rgba-1to1.bin`)), B = fs.readFileSync(out);
  if (A.length !== B.length) { fails++; console.log(`  FAIL ${f.name}: ${A.length} vs ${B.length} bytes`); continue; }
  let differ = 0, max = 0, n = 0;
  for (let i = 0; i < A.length; i++) { if ((i & 3) === 3) continue; n++; const d = Math.abs(A[i] - B[i]); if (d) { differ++; if (d > max) max = d; } }
  const pct = (100 * differ) / n;
  const ok = max <= 1 && pct <= 0.5;
  if (!ok) fails++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${f.name.padEnd(22)} ${f.format} ${f.coded.join('x')} coded, ${f.visible.slice(2).join('x')} visible, ${f.colorSpace.matrix}${f.colorSpace.fullRange ? ' full' : ' limited'}: ${(100 - pct).toFixed(2)}% identical, max ${max}`);
}

// ── 2. the LEDs ─────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. THE LEDS (the app\'s WebGPUMapper with the VideoFrames, against the engine\'s --frame-once)');
for (const [ji, job] of jobs.entries()) {
  // Only what both sides drew: a file the engine refused (colour space) leaves its surface out of the rig.
  const keep = job.surfaces.filter((s) => decoded.has(s.name)).map((s) => s.id);
  const proj = path.join(WORK, `project-${ji}.artlux`);
  fs.writeFileSync(proj, JSON.stringify({ surfaces: job.surfaces, fixtures: job.fixtures }));
  const outp = path.join(WORK, `engine-${ji}.json`);
  execFileSync(ENGINE, ['--frame-once', proj, outp, '--brightness', String(job.brightness)], { stdio: 'inherit' });
  const e = JSON.parse(fs.readFileSync(outp, 'utf8'));
  const A = Buffer.from(browser.cases[ji].rgbw, 'base64'), B = Buffer.from(e.rgbw, 'base64');
  if (A.length !== B.length) { fails++; console.log(`FAIL ${job.name}: ${A.length} vs ${B.length} bytes`); continue; }
  console.log(`  ${job.name} — browser: ${browser.adapter}; engine: ${e.adapter}`);
  let offset = 0;
  const per = {};
  for (const f of job.fixtures) {
    const st = (per[f.surfaceId] ??= { n: 0, exact: 0, max: 0 });
    for (let i = 0; i < f.ledCount; i++, offset++) {
      let worst = 0;
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(A[offset * 4 + c] - B[offset * 4 + c]));
      st.n++; if (!worst) st.exact++; st.max = Math.max(st.max, worst);
    }
  }
  for (const [sid, st] of Object.entries(per)) {
    if (!keep.includes(sid)) continue;
    const ok = st.max <= 1;
    if (!ok) fails++;
    console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${sid.slice(2).padEnd(22)} ${String(st.n).padStart(4)} LEDs: ${(100 * st.exact / st.n).toFixed(1).padStart(5)}% identical, max ${st.max}`);
  }
}
console.log(fails ? `\nMP4 PARITY: ${fails} failure(s)` : '\nMP4 PARITY OK');
process.exit(fails ? 1 : 0);
