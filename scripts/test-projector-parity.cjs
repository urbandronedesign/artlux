#!/usr/bin/env node
// E1e-1 PROJECTOR PARITY: the engine's projector renderer (engine/artlux-engine/src/projector.rs) against the
// app's REAL ProjectorGL — the 2D warp path every uncalibrated projector output takes — pixel by pixel.
//
//   node scripts/test-projector-parity.cjs [extra pictures…]
//
// The same picture through the same settings on both: corner-pins (identity, keystone, strong perspective,
// a heavy minification that reaches the mips), a Bézier warp, soft edges, output gamma + brightness, colour
// gain + black lift, with 4× MSAA and without. Both read back at the raster's own size, top row first.
// Each line: exact %, median / p99 / max per-channel difference.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const WORK = path.join(os.tmpdir(), 'artlux-projector-parity');
fs.mkdirSync(WORK, { recursive: true });
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function writePng(name, w, h, px) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); const i = (y * w + x) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; }
  const f = path.join(WORK, name);
  fs.writeFileSync(f, PNG.sync.write(png));
  return f;
}
const r = rng(5);
const noise = Array.from({ length: 640 * 360 * 3 }, () => Math.floor(r() * 256));
const blobs = Array.from({ length: 12 }, () => [r() * 1280, r() * 720, 80 + r() * 300, [r() * 255, r() * 255, r() * 255]]);
const pictures = [
  writePng('sharp-1920x1080.png', 1920, 1080, (x, y) => (x % 97 === 0 || y % 89 === 0 ? [255, 255, 255] : [Math.round((x / 1919) * 255), Math.round((y / 1079) * 255), ((x >> 5) + (y >> 5)) % 2 ? 230 : 20])),
  writePng('photo-1280x720.png', 1280, 720, (x, y) => {
    let c = [30, 30, 40];
    for (const [bx, by, br, col] of blobs) { const d = Math.hypot(x - bx, y - by) / br; if (d < 1) { const k = (1 - d) * (1 - d); c = c.map((v, q) => v + (col[q] - v) * k); } }
    return c.map((v) => Math.round(v));
  }),
  writePng('noise-640x360.png', 640, 360, (x, y) => { const i = (y * 640 + x) * 3; return [noise[i], noise[i + 1], noise[i + 2]]; }),
  ...process.argv.slice(2).map((f) => path.resolve(f)),
];

const pin = (tl, tr, br, bl) => ({ tl, tr, br, bl });
const ID = pin([0, 0], [1, 0], [1, 1], [0, 1]);
const KEY = pin([0.05, 0.1], [0.93, 0.02], [0.97, 0.95], [0.02, 0.88]);
const soft0 = { left: 0, right: 0, top: 0, bottom: 0, gamma: 2.2 };
// A Bézier net: the keystone's flat net (makeBezierWarp samples the homography at thirds) with the interior
// control points pulled — a curved screen.
const H = (u, v) => { const x = [0.05, 0.93, 0.97, 0.02], y = [0.1, 0.02, 0.95, 0.88]; const a = (1 - u) * (1 - v), b = u * (1 - v), c = u * v, d = (1 - u) * v; return [a * x[0] + b * x[1] + c * x[2] + d * x[3], a * y[0] + b * y[1] + c * y[2] + d * y[3]]; };
const net = []; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const p = H(i / 3, j / 3); const inner = i > 0 && i < 3 && j > 0 && j < 3; net.push(inner ? [p[0] + 0.06 * (i - 1.5), p[1] - 0.08] : p); }
const out = (o) => ({ cornerPin: ID, softEdge: soft0, gamma: 1, ...o });
const cases = [
  { name: 'identity · MSAA 4', output: out({}), brightness: 1, aa: 4 },
  { name: 'identity · no MSAA', output: out({}), brightness: 1, aa: 1 },
  { name: 'keystone', output: out({ cornerPin: KEY }), brightness: 1, aa: 4 },
  { name: 'strong perspective', output: out({ cornerPin: pin([0.3, 0.3], [0.7, 0.3], [1, 1], [0, 1]) }), brightness: 1, aa: 4 },
  { name: 'shrunk to 1/5 (mips)', output: out({ cornerPin: pin([0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]) }), brightness: 1, aa: 4 },
  // ~1/80 of the source per pixel: past mip level 4, where the app's TEXTURE_MAX_LEVEL 4 caps the chain.
  { name: 'shrunk to 1/80 (level cap)', output: out({ cornerPin: pin([0.49, 0.49], [0.515, 0.49], [0.515, 0.515], [0.49, 0.515]) }), brightness: 1, aa: 4 },
  { name: 'Bézier warp', output: out({ cornerPin: KEY, warp: { points: net } }), brightness: 1, aa: 4 },
  { name: 'soft edges L 0.2 R 0.15', output: out({ softEdge: { left: 0.2, right: 0.15, top: 0, bottom: 0, gamma: 2.2 } }), brightness: 1, aa: 4 },
  { name: 'gamma 2.2 · brightness 0.7', output: out({ gamma: 2.2 }), brightness: 0.7, aa: 4 },
  { name: 'gain + black lift + top edge', output: out({ cornerPin: KEY, softEdge: { left: 0, right: 0, top: 0.1, bottom: 0, gamma: 1.8 }, colorGain: [1, 0.9, 0.8], blackLift: [0.02, 0.03, 0.01] }), brightness: 1, aa: 4 },
];
const W = 960, Hh = 540;
const job = { width: W, height: Hh, pictures, cases };

// ── the app side ───────────────────────────────────────────────────────────────────────────────────────
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const pageBundle = path.join(WORK, 'page.js');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'engine', 'spikes', 'projector-parity', 'page.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: pageBundle, logLevel: 'error' });
fs.writeFileSync(path.join(WORK, 'cases.json'), JSON.stringify(job));
const env = { ...process.env, SPIKE_OUT: WORK, SPIKE_PAGE: pageBundle };
delete env.ELECTRON_RUN_AS_NODE;
try { fs.unlinkSync(path.join(WORK, 'gpu-cases.json')); } catch { /* fresh */ }
spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  [path.join(ROOT, 'engine', 'spikes', 'sampling-parity')], { env, stdio: 'ignore', timeout: 120000 });
const app = JSON.parse(fs.readFileSync(path.join(WORK, 'gpu-cases.json'), 'utf8'));
if (app.error) { console.log(`the app side failed: ${app.error}`); process.exit(1); }

// ── the engine side + the comparison ─────────────────────────────────────────────────────────────────
let fails = 0;
// THE GATE: identical. Every pixel of every case was, once the engine rasterises bottom-up like the
// app's canvas (projector.rs render) — so any difference is a regression, not noise.
const TOL = { ok: (hist, n) => hist[0] === n };
for (const [pi, picture] of pictures.entries()) {
  const inp = path.join(WORK, `engine-in-${pi}.json`), outp = path.join(WORK, `engine-out-${pi}.json`);
  fs.writeFileSync(inp, JSON.stringify({ width: W, height: Hh, picture, cases }));
  execFileSync(ENGINE, ['--project-once', inp, outp], { stdio: 'inherit' });
  const eng = JSON.parse(fs.readFileSync(outp, 'utf8'));
  console.log(`\n${path.basename(picture)} on a ${W}×${Hh} raster (engine: ${eng.adapter})`);
  for (const [ci, c] of cases.entries()) {
    const A = Buffer.from(app.pictures[pi].cases[ci].rgba, 'base64'), B = Buffer.from(eng.cases[ci].rgba, 'base64');
    if (A.length !== B.length) { fails++; console.log(`  FAIL ${c.name}: ${A.length} vs ${B.length} bytes`); continue; }
    const hist = new Array(256).fill(0);
    let lit = 0;
    for (let i = 0; i < A.length; i += 4) {
      let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k]));
      hist[d]++; if (A[i] + A[i + 1] + A[i + 2] > 0) lit++;
    }
    const n = A.length / 4;
    const q = (f) => { let s = 0; for (let d = 0; d < 256; d++) { s += hist[d]; if (s >= f * n) return d; } return 255; };
    const max = hist.findLastIndex((v) => v > 0), mean = hist.reduce((s, v, d) => s + v * d, 0) / n;
    // WHERE the large differences are: on the picture's OUTLINE (a pixel next to one the app left black —
    // anti-aliased edge coverage) or inside it.
    let big = 0, edge = 0;
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k]));
      if (d <= 8) continue;
      big++;
      let nearBlack = false;
      for (let dy = -1; dy <= 1 && !nearBlack; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= Hh) continue;
        const j = (yy * W + xx) * 4; if (A[j] + A[j + 1] + A[j + 2] === 0 || B[j] + B[j + 1] + B[j + 2] === 0) { nearBlack = true; break; }
      }
      if (nearBlack) edge++;
    }
    c.big = big; c.edge = edge;
    const ok = TOL.ok(hist, n, big, edge);
    if (!ok) fails++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(30)} ${(100 * hist[0] / n).toFixed(2).padStart(6)}% exact · ≤1 ${(100 * (hist[0] + hist[1]) / n).toFixed(2).padStart(6)}% · p99 ${q(0.99)} · p99.9 ${q(0.999)} · max ${max} · mean ${mean.toFixed(3)} · ${(100 * lit / n).toFixed(0)}% lit${big ? ` · ${big} px > 8, ${edge} on the outline` : ''}`);
  }
}
console.log(fails ? `\nPROJECTOR PARITY FAILED: ${fails} case(s)` : '\nPROJECTOR PARITY OK');
process.exit(fails ? 1 : 0);
