#!/usr/bin/env node
// E1d — STILL IMAGES: the engine's LEDs against the app's, on the same project. Chromium decodes the file
// and Skia stretches it into the atlas cell; the engine decodes with the `image` crate and stretches with
// the GPU (engine/artlux-engine/src/compose.rs).
//
// THE GATE, per picture: byte-identical to the browser — OR at least as close as the browser to an
// ALIAS-FREE REFERENCE (the picture area-averaged exactly into its cell, read at the LEDs as the shader reads
// the atlas). Not "identical" outright because Skia's downscale could not be reproduced bit for bit at every
// size (it is identical at many: see the report), and the browser is not the truth either — where the two
// differ, the browser is the one aliasing more. So the rule is: never less faithful than today.
// Each line reports exact %, median / p99 / max difference to the browser, and both distances to the
// reference. Extra pictures (a JPEG, a show's real artwork) can be named on the command line.
//
//   node scripts/test-image-parity.cjs
//
// Pictures (PNG — lossless, so the DECODERS agree and the difference is the stretch alone): a 1920×1080
// with gradients, a checkerboard and 1-pixel lines (heavy downscale, the aliasing worst case); 640×360 of
// per-pixel noise (the worst case for any resampler); a soft 1280×720 "photo"; a 48×27 upscaled; a 256×256
// with an alpha gradient. Each on its own surface, with a horizontal strip, a vertical strip and a
// serpentine matrix; one surface at 60% opacity; brightness 1 and 0.8.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const WORK = path.join(os.tmpdir(), 'artlux-image-parity');
fs.mkdirSync(WORK, { recursive: true });
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));


function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function writePng(name, w, h, px) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a] = px(x, y); const i = (y * w + x) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a ?? 255; }
  const f = path.join(WORK, name);
  fs.writeFileSync(f, PNG.sync.write(png));
  return f;
}
const r = rng(7);
const noise = Array.from({ length: 640 * 360 * 3 }, () => Math.floor(r() * 256));
const blobs = Array.from({ length: 12 }, () => [r() * 1280, r() * 720, 80 + r() * 300, [r() * 255, r() * 255, r() * 255]]);
const small = Array.from({ length: 48 * 27 * 3 }, () => Math.floor(r() * 256));
const PICS = {
  sharp: writePng('sharp-1920x1080.png', 1920, 1080, (x, y) => {
    if (x % 97 === 0 || y % 89 === 0) return [255, 255, 255];
    return [Math.round((x / 1919) * 255), Math.round((y / 1079) * 255), ((x >> 5) + (y >> 5)) % 2 ? 230 : 20];
  }),
  noise: writePng('noise-640x360.png', 640, 360, (x, y) => { const i = (y * 640 + x) * 3; return [noise[i], noise[i + 1], noise[i + 2]]; }),
  photo: writePng('photo-1280x720.png', 1280, 720, (x, y) => {
    let c = [30, 30, 40];
    for (const [bx, by, br, col] of blobs) { const d = Math.hypot(x - bx, y - by) / br; if (d < 1) { const k = (1 - d) * (1 - d); c = c.map((v, q) => v + (col[q] - v) * k); } }
    return c.map((v) => Math.round(v));
  }),
  small: writePng('small-48x27.png', 48, 27, (x, y) => { const i = (y * 48 + x) * 3; return [small[i], small[i + 1], small[i + 2]]; }),
  alpha: writePng('alpha-256x256.png', 256, 256, (x, y) => [x, 255 - y, 128, Math.round(Math.min(1, Math.hypot(x - 128, y - 128) / 128) * 255)]),
  // The size sweep: the same sharp pattern at sizes where Skia's downscale and the engine's part ways.
  sharp2k: writePng('sharp-2048x1280.png', 2048, 1280, (x, y) => (x % 97 === 0 || y % 89 === 0 ? [255, 255, 255] : [Math.round((x / 2047) * 255), Math.round((y / 1279) * 255), ((x >> 5) + (y >> 5)) % 2 ? 230 : 20])),
  sharp4k: writePng('sharp-4096x2560.png', 4096, 2560, (x, y) => (x % 97 === 0 || y % 89 === 0 ? [255, 255, 255] : [Math.round((x / 4095) * 255), Math.round((y / 2559) * 255), ((x >> 5) + (y >> 5)) % 2 ? 230 : 20])),
};
// Extra pictures named on the command line (a JPEG, a show's real artwork), each on a surface of its own.
process.argv.slice(2).forEach((f, i) => { PICS[`extra${i}`] = path.resolve(f); });

// ── the project ────────────────────────────────────────────────────────────────────────────────────────
const surfaces = [], fixtures = [];
Object.entries(PICS).forEach(([key, file], k) => {
  const sx = 0.05 + (k % 3) * 0.32, sy = 0.05 + Math.floor(k / 3) * 0.48;
  const sid = `s_${key}`;
  surfaces.push({ id: sid, name: key, x: sx, y: sy, width: 0.28, height: 0.4, rotation: 0, zIndex: k,
    content: { type: 'IMAGE', url: file, ...(key === 'photo' ? { opacity: 0.6 } : {}) } });
  const base = { rotation: 0, reverse: false, colorData: [], universe: 0, startAddress: 1, surfaceId: sid };
  fixtures.push({ ...base, id: `${sid}_h`, name: `${key} H`, x: sx + 0.01, y: sy + 0.1, width: 0.26, height: 0.004, ledCount: 120 });
  fixtures.push({ ...base, id: `${sid}_v`, name: `${key} V`, x: sx + 0.2, y: sy + 0.01, width: 0.004, height: 0.38, ledCount: 60 });
  fixtures.push({ ...base, id: `${sid}_m`, name: `${key} M`, x: sx + 0.02, y: sy + 0.2, width: 0.2, height: 0.15, ledCount: 32 * 16,
    shape: 'MATRIX', matrixWidth: 32, matrixHeight: 16, serpentine: true });
});
const jobs = [1, 0.8].map((b) => ({ name: `brightness ${b}`, brightness: b, surfaces, fixtures }));

// ── the browser side (the app's WebGPUMapper) ───────────────────────────────────────────────────────────
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const pageBundle = path.join(WORK, 'page.js');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'engine', 'spikes', 'image-parity', 'page.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: pageBundle, logLevel: 'error' });
fs.writeFileSync(path.join(WORK, 'cases.json'), JSON.stringify(jobs));
const env = { ...process.env, SPIKE_OUT: WORK, SPIKE_PAGE: pageBundle };
delete env.ELECTRON_RUN_AS_NODE;
try { fs.unlinkSync(path.join(WORK, 'gpu-cases.json')); } catch { /* fresh */ }
spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  [path.join(ROOT, 'engine', 'spikes', 'sampling-parity')], { env, stdio: 'ignore', timeout: 120000 });
const browser = JSON.parse(fs.readFileSync(path.join(WORK, 'gpu-cases.json'), 'utf8'));
if (browser.error) { console.log(`the WebGPU page failed: ${browser.error}`); process.exit(1); }

// ── THE REFERENCE: what an ideal sampler would give ───────────────────────────────────────────────────────
// Neither side is "right" by being the other: Chromium's downscale is a choice too. So both are also held to
// an ALIAS-FREE reference: each picture area-averaged EXACTLY into its atlas cell (every source pixel
// weighted by how much of it a cell texel covers), then read at the LEDs exactly as the shader reads the
// atlas (the proven layout module's UVs, bilinear between texel centres), opacity, RGB→RGBW, brightness.
// The mean distance to it says which pipeline shows the picture more faithfully.
const layoutBundle = path.join(WORK, 'layout-ts.cjs');
esbuild.buildSync({ stdin: { contents: `export * from './src/renderer/gpu/ledLayout';`, resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: layoutBundle, logLevel: 'error' });
const L = require(layoutBundle);
function decoded(file) {
  // ⚠ THE REFERENCE MUST NOT SHARE THE ENGINE'S DECODE, or a decoder bug moves the reference with the
  // engine and the gate cannot see it (a first version did exactly that: an engine that skipped
  // premultiplication passed). PNG: decoded here with pngjs and premultiplied with Skia's rounding.
  if (/\.png$/i.test(file)) {
    const png = PNG.sync.read(fs.readFileSync(file));
    const px = Buffer.from(png.data);
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a !== 255) for (let c = 0; c < 3; c++) { const p = px[i + c] * a + 128; px[i + c] = (p + (p >> 8)) >> 8; }
    }
    return { w: png.width, h: png.height, px };
  }
  // JPEG: no independent decoder in Node here, so the engine's (it agrees with Chromium's within ±3 per
  // pixel — measured). A JPEG's reference is therefore only as independent as that agreement.
  const raw = path.join(WORK, `${path.basename(file)}.raw`);
  const dims = execFileSync(ENGINE, ['--decode', file, raw], { encoding: 'utf8' }).trim().split('x').map(Number);
  return { w: dims[0], h: dims[1], px: fs.readFileSync(raw) };
}
function areaAverage(pic, cw, ch) {
  // Separable exact box filter: x then y, fractional coverage at the edges of each destination texel.
  const axis = (n, len) => Array.from({ length: n }, (_, i) => {
    const a = (i * len) / n, b = ((i + 1) * len) / n, taps = [];
    for (let s = Math.floor(a); s < Math.ceil(b); s++) taps.push([s, Math.min(b, s + 1) - Math.max(a, s)]);
    const t = b - a; return taps.map(([s, wgt]) => [s, wgt / t]);
  });
  const ax = axis(cw, pic.w), ay = axis(ch, pic.h);
  const tmp = new Float64Array(cw * pic.h * 4);
  for (let y = 0; y < pic.h; y++) for (let x = 0; x < cw; x++) for (const [s, wgt] of ax[x]) for (let c = 0; c < 4; c++) tmp[(y * cw + x) * 4 + c] += pic.px[(y * pic.w + s) * 4 + c] * wgt;
  const out = new Float64Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (const [s, wgt] of ay[y]) for (let x = 0; x < cw; x++) for (let c = 0; c < 4; c++) out[(y * cw + x) * 4 + c] += tmp[(s * cw + x) * 4 + c] * wgt;
  return out;
}
function reference(job) {
  const order = L.surfaceOrderOf(fixtures, surfaces);
  const d = L.buildLedData(fixtures, surfaces, order, L.countSegments(fixtures));
  const plan = L.planAtlas(order, fixtures, surfaces, 8192);
  const cells = order.map((sid, k) => {
    const s = surfaces.find((x) => x.id === sid), r = plan.packed.rects[k];
    return { r, op: s.content.opacity ?? 1, img: areaAverage(decoded(s.content.url), r.w, r.h) };
  });
  const out = new Uint8Array(d.total * 4);
  const toByte = (v) => Math.floor(Math.min(1, Math.max(0, v)) * 255 + 0.5);
  for (let i = 0; i < d.total; i++) {
    const cell = cells[Math.round(d.meta[i * 4 + 3])];
    if (!cell) continue;
    const { r, img, op } = cell;
    const cx = Math.min(1, Math.max(0, d.led[i * 4])) * (r.w - 1), cy = Math.min(1, Math.max(0, d.led[i * 4 + 1])) * (r.h - 1);
    const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(r.w - 1, x0 + 1), y1 = Math.min(r.h - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
    const at = (x, y, c) => img[(y * r.w + x) * 4 + c] / 255;
    const col = [0, 1, 2].map((c) => ((at(x0, y0, c) * (1 - fx) + at(x1, y0, c) * fx) * (1 - fy) + (at(x0, y1, c) * (1 - fx) + at(x1, y1, c) * fx) * fy) * op);
    const m = Math.min(...col), b = job.brightness;
    out.set([toByte((col[0] - m) * b), toByte((col[1] - m) * b), toByte((col[2] - m) * b), toByte(m * b)], i * 4);
  }
  return out;
}
const meanTo = (X, R, from, n) => { let s = 0; for (let i = from * 4; i < (from + n) * 4; i++) s += Math.abs(X[i] - R[i]); return s / (n * 4); };

// ── the engine side ─────────────────────────────────────────────────────────────────────────────────────
let fails = 0;
let engineAdapter = '';
const ledsOf = (sid) => fixtures.filter((f) => f.surfaceId === sid);
for (const [ji, job] of jobs.entries()) {
  const proj = path.join(WORK, `project-${ji}.artlux`);
  fs.writeFileSync(proj, JSON.stringify({ surfaces, fixtures }));
  const out = path.join(WORK, `engine-${ji}.json`);
  execFileSync(ENGINE, ['--frame-once', proj, out, '--brightness', String(job.brightness)], { stdio: 'inherit' });
  const e = JSON.parse(fs.readFileSync(out, 'utf8'));
  engineAdapter = e.adapter;
  const A = Buffer.from(browser.cases[ji].rgbw, 'base64'), B = Buffer.from(e.rgbw, 'base64');
  const REF = reference(job);
  if (A.length !== B.length) { fails++; console.log(`FAIL ${job.name}: ${A.length} vs ${B.length} bytes`); continue; }
  console.log(`\n${job.name} — ${A.length / 4} LEDs (browser: ${browser.adapter}; engine: ${engineAdapter})`);
  // Per picture: the LEDs of its surface's fixtures, in canonical order.
  let offset = 0;
  const per = {};
  for (const f of fixtures) {
    const key = f.surfaceId.slice(2);
    const st = (per[key] ??= { n: 0, exact: 0, diffs: [], from: offset });
    for (let i = 0; i < f.ledCount; i++, offset++) {
      let worst = 0;
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(A[offset * 4 + c] - B[offset * 4 + c]));
      st.n++; if (!worst) st.exact++; st.diffs.push(worst);
    }
  }
  for (const [key, st] of Object.entries(per)) {
    st.diffs.sort((a, b) => a - b);
    const p = (q) => st.diffs[Math.min(st.diffs.length - 1, Math.floor(q * st.diffs.length))];
    const mean = st.diffs.reduce((a, b) => a + b, 0) / st.n;
    const toB = meanTo(A, REF, st.from, st.n), toE = meanTo(B, REF, st.from, st.n);
    const identical = st.diffs[st.n - 1] === 0;
    // Never less faithful than today (0.02: rounding noise on a mean over hundreds of LEDs).
    const ok = identical || toE <= toB + 0.02;
    if (!ok) fails++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${key.padEnd(6)} ${String(st.n).padStart(4)} LEDs: ${(100 * st.exact / st.n).toFixed(1).padStart(5)}% exact · median ${p(0.5)} · p99 ${p(0.99)} · max ${st.diffs[st.n - 1]} · mean ${mean.toFixed(2)} | to the alias-free reference: browser ${toB.toFixed(2)}, engine ${toE.toFixed(2)}${identical ? '' : toE < toB ? ' (engine more faithful)' : ''}`);
  }
}
console.log(fails ? `\nIMAGE PARITY FAILED: ${fails} picture(s) where the engine is LESS faithful than the browser` : '\nIMAGE PARITY OK: every picture identical to the browser, or more faithful to the reference');
process.exit(fails ? 1 : 0);
