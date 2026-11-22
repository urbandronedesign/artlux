#!/usr/bin/env node
// E1b-2 PARITY — LED SAMPLING: the native engine against the app's WebGPUMapper.
//
//   node scripts/test-sampling-parity.cjs [more.artlux …]           the layout half (pure, Node)
//   node scripts/test-sampling-parity.cjs --gpu [more.artlux …]     + the GPU half (Electron, WebGPU)
//
// THE LAYOUT HALF (CPU): src/renderer/gpu/ledLayout.ts — bundled with esbuild, the REAL module — against
// `artlux-engine --layout-batch` (engine/artlux-engine/src/layout.rs). Compared BIT FOR BIT: every f32 the
// GPU reads (per-LED UV / t / segment, the meta, the segment params, the atlas rect UVs) as its u32 bit
// pattern, never through a decimal; and the atlas plan (surface order, cell rects, size, oversample).
// Cases: every examples/**/*.artlux rig, any rig named on the command line, and synthetic rigs built to
// hit every branch — lines horizontal and vertical, matrices with serpentine, LED maps (short, with nulls),
// reverse, segments (gaps, off segments), rotated fixtures and surfaces, unlinked fixtures, RGBW NONE, and
// small texture limits that force the atlas to degrade.
//
// THE GPU HALF (--gpu): runs the app's REAL WebGPUMapper in an Electron 42 page (Chromium WebGPU — D3D12
// on Windows) on synthetic surface pictures, takes the EXACT atlas it uploaded and the bytes it read back,
// and asks the engine (`artlux-engine --sample-batch`, wgpu) to sample that same atlas with that same
// layout. Same bytes or it fails. (Building the atlas itself — scaling each surface into its cell — is the
// sources' business, E1d: Canvas2D's scaler is not reproducible bit for bit, so it is judged there.)

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const WORK = path.join(os.tmpdir(), 'artlux-sampling-parity');
fs.mkdirSync(WORK, { recursive: true });
if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} — npm run build:engine`); process.exit(2); }
const GPU = process.argv.includes('--gpu');
const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const bundle = path.join(WORK, 'layout-ts.cjs');
esbuild.buildSync({
  stdin: { contents: `export * from './src/renderer/gpu/ledLayout';`, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
});
const L = require(bundle);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────────────
const cases = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.artlux') ? [path.join(d, e.name)] : []);
let projectCount = 0;
for (const file of [...walk(path.join(ROOT, 'examples')), ...extra.map((a) => path.resolve(a))]) {
  let p; try { p = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  if (!(p.fixtures || []).length) continue;
  projectCount++;
  for (const maxDim of [8192, 512]) cases.push({ name: `${path.relative(ROOT, file)} [max ${maxDim}]`, fixtures: p.fixtures, surfaces: p.surfaces || [], maxDim });
}
const r = rng(20261122);
const pick = (xs) => xs[Math.floor(r() * xs.length)];
const num = (a, b) => a + r() * (b - a);
for (let k = 0; k < 300; k++) {
  const surfaces = [];
  const ns = 1 + Math.floor(r() * 4);
  for (let s = 0; s < ns; s++) {
    surfaces.push({ id: `s${s}`, name: `S${s}`, x: num(-0.2, 0.8), y: num(-0.2, 0.8), width: pick([num(0.05, 1), 0, 1]), height: pick([num(0.05, 1), 1]),
      rotation: pick([0, 0, num(-180, 180), undefined]), zIndex: s, content: { type: 'NONE' } });
  }
  const fixtures = [];
  const nf = 1 + Math.floor(r() * 8);
  for (let i = 0; i < nf; i++) {
    const matrix = r() < 0.3;
    const ledCount = matrix ? 0 : pick([1, 2, 7, 30, 64, 150]);
    const mw = 1 + Math.floor(r() * 16), mh = 1 + Math.floor(r() * 12);
    const f = {
      id: `f${k}_${i}`, name: `F${i}`, x: num(-0.1, 0.9), y: num(-0.1, 0.9),
      width: pick([num(0.01, 0.8), 0.02]), height: pick([num(0.002, 0.6), 0.5]),
      rotation: pick([0, 0, num(-360, 360), 90, undefined]),
      ledCount: matrix ? mw * mh + pick([0, 0, -3, 5]) : ledCount,
      universe: 0, startAddress: 1, reverse: pick([false, true, undefined]), colorData: [],
      surfaceId: pick([...surfaces.map((s) => s.id), undefined, 'gone']),
      rgbwMode: pick([undefined, 'SUBTRACT', 'NONE']),
    };
    if (f.ledCount < 0) f.ledCount = 1;
    if (matrix) { f.shape = 'MATRIX'; f.matrixWidth = pick([mw, undefined]); f.matrixHeight = mh; f.serpentine = pick([true, false, undefined]); }
    if (r() < 0.2) f.ledMap = Array.from({ length: Math.max(0, f.ledCount - pick([0, 3])) }, (_, q) => (r() < 0.1 ? null : Math.floor(r() * f.ledCount)));
    if (r() < 0.25 && f.ledCount > 4) {
      const a = Math.floor(f.ledCount / 3), b = Math.floor((2 * f.ledCount) / 3);
      f.segments = [{ id: 'a', start: 0, stop: a }, { id: 'b', start: a + 1, stop: b, off: pick([true, false, undefined]) }, { id: 'c', start: b, stop: f.ledCount + pick([0, 2]) }];
    }
    fixtures.push(f);
  }
  cases.push({ name: `synthetic #${k}`, fixtures, surfaces, maxDim: pick([8192, 8192, 1024, 256, 64]) });
}

// ── the TypeScript side, as WebGPUMapper.updateMapping computes it ──────────────────────────────────────
const bits = (fa) => Array.from(new Uint32Array(Float32Array.from(fa).buffer));
function runTs(c) {
  const order = L.surfaceOrderOf(c.fixtures, c.surfaces);
  const segCount = L.countSegments(c.fixtures);
  const d = L.buildLedData(c.fixtures, c.surfaces, order, segCount);
  const plan = L.planAtlas(order, c.fixtures, c.surfaces, c.maxDim);
  const rectData = plan.packed ? L.atlasRectData(plan.packed.rects, plan.packed.w, plan.packed.h) : new Float32Array(0);
  return {
    name: c.name, surfaceOrder: order, segCount, total: d.total,
    led: bits(d.led), meta: bits(d.meta), segParams: bits(L.buildSegParams(c.fixtures)),
    plan: { packed: plan.packed, usedOversample: plan.usedOversample }, rectData: bits(rectData),
  };
}

const inFile = path.join(WORK, 'layout-in.json'), outFile = path.join(WORK, 'layout-out.json');
fs.writeFileSync(inFile, JSON.stringify(cases));
try { execFileSync(ENGINE, ['--layout-batch', inFile, outFile], { stdio: ['ignore', 'inherit', 'pipe'] }); }
catch (e) {
  console.log(`the engine failed on the layout batch: ${String(e.stderr).trim().split(/\r?\n/).slice(-2).join(' ')}`);
  console.log('PARITY FAILED');
  process.exit(1);
}
const rust = JSON.parse(fs.readFileSync(outFile, 'utf8'));
let fails = 0, floats = 0, ulpWorst = 0;
const FIELDS = ['surfaceOrder', 'segCount', 'total', 'led', 'meta', 'segParams', 'plan', 'rectData'];
for (let i = 0; i < cases.length; i++) {
  const want = runTs(cases[i]);
  const got = rust[i];
  floats += want.led.length + want.meta.length + want.segParams.length + want.rectData.length;
  const bad = FIELDS.filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
  if (bad.length) {
    fails++;
    if (fails <= 6) {
      const k = bad[0];
      let detail = '';
      if (Array.isArray(want[k]) && typeof want[k][0] === 'number' && k !== 'surfaceOrder') {
        const at = want[k].findIndex((v, q) => v !== got[k][q]);
        const f32 = (u) => new Float32Array(new Uint32Array([u]).buffer)[0];
        const ulp = Math.abs(want[k][at] - got[k][at]);
        ulpWorst = Math.max(ulpWorst, ulp);
        detail = `${k}[${at}]: TS ${f32(want[k][at])} vs Rust ${f32(got[k][at])} (${ulp} ulp)`;
      } else detail = `${k}: TS ${JSON.stringify(want[k]).slice(0, 160)} vs Rust ${JSON.stringify(got[k]).slice(0, 160)}`;
      console.log(`FAIL ${cases[i].name} — ${bad.join(', ')}\n   ${detail}`);
    }
  }
}
console.log(`layout: ${projectCount} projects, ${cases.length} cases, ${floats} f32 values compared bit for bit: ${fails ? `${fails} DIFFER` : 'identical'}`);
if (!GPU) { console.log(fails ? 'PARITY FAILED' : 'PARITY OK (layout; --gpu adds the sampling pass)'); process.exit(fails ? 1 : 0); }

// ── the GPU half ──────────────────────────────────────────────────────────────────────────────────────
// Runs the spike app in engine/spikes/sampling-parity, which writes gpu-cases.json: per case the atlas
// RGBA bytes WebGPUMapper uploaded, its layout buffers, its brightness, and the bytes it read back.
const gpuOut = path.join(WORK, 'gpu');
fs.mkdirSync(gpuOut, { recursive: true });
const pageBundle = path.join(gpuOut, 'page.js');
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'engine', 'spikes', 'sampling-parity', 'page.ts')],
  bundle: true, platform: 'browser', format: 'iife', outfile: pageBundle, logLevel: 'error',
  alias: { '@artlux/sdk/renderer': path.join(ROOT, 'packages', 'sdk', 'src', 'renderer.ts') },
});
const gpuCases = cases.filter((c, i) => i % 3 === 0 && c.fixtures.some((f) => f.ledCount > 0)).slice(0, 60);
fs.writeFileSync(path.join(gpuOut, 'cases.json'), JSON.stringify(gpuCases));
const env = { ...process.env, SPIKE_OUT: gpuOut, SPIKE_PAGE: pageBundle };
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
  [path.join(ROOT, 'engine', 'spikes', 'sampling-parity')], { env, stdio: 'inherit', timeout: 180000 });
let browser;
try { browser = JSON.parse(fs.readFileSync(path.join(gpuOut, 'gpu-cases.json'), 'utf8')); } catch (e) { console.log(`no GPU results: ${e.message}`); console.log('PARITY FAILED'); process.exit(1); }
if (browser.error) { console.log(`the WebGPU page failed: ${browser.error}`); console.log('PARITY FAILED'); process.exit(1); }
const sIn = path.join(gpuOut, 'sample-in.json'), sOut = path.join(gpuOut, 'sample-out.json');
fs.writeFileSync(sIn, JSON.stringify(browser.cases.map((c) => ({ name: c.name, atlasW: c.atlasW, atlasH: c.atlasH, atlas: c.atlas, led: c.led, meta: c.meta, segParams: c.segParams, rects: c.rects, brightness: c.brightness, surfaces: c.surfaces }))));
try { execFileSync(ENGINE, ['--sample-batch', sIn, sOut], { stdio: ['ignore', 'inherit', 'pipe'] }); }
catch (e) { console.log(`the engine failed on the sample batch: ${String(e.stderr).trim().split(/\r?\n/).slice(-2).join(' ')}`); console.log('PARITY FAILED'); process.exit(1); }
const sampled = JSON.parse(fs.readFileSync(sOut, 'utf8'));
let gFails = 0, gBytes = 0, worst = 0, diffBytes = 0;
browser.cases.forEach((c, i) => {
  const want = Buffer.from(c.out, 'base64'), got = Buffer.from(sampled.cases[i].out, 'base64');
  gBytes += want.length;
  let d = 0;
  for (let q = 0; q < Math.max(want.length, got.length); q++) { const x = Math.abs((want[q] ?? -999) - (got[q] ?? -999)); if (x) { d++; worst = Math.max(worst, x); } }
  diffBytes += d;
  if (d) { gFails++; if (gFails <= 6) console.log(`FAIL (gpu) ${c.name}: ${d}/${want.length} bytes differ, worst by ${worst}`); }
});
console.log(`sampling: ${browser.adapter} vs ${sampled.adapter}; ${browser.cases.length} cases, ${gBytes} bytes: ${gFails ? `${gFails} cases DIFFER (${diffBytes} bytes, worst ${worst})` : 'identical'}`);
const failed = fails || gFails;
console.log(failed ? 'PARITY FAILED' : 'PARITY OK');
process.exit(failed ? 1 : 0);
