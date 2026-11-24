#!/usr/bin/env node
// E2 — SHADERS IN THE NATIVE ENGINE, held to the app (plans/native-engine.md "E2 shaders").
//
//   node scripts/test-shader-parity.cjs --packaged <ArtLux.exe>
//
// 1. THE CORPUS: every shader ArtLux ships — the starters, the cookbook, the node editor's examples (their
//    generated GLSL) and every SHADER surface in examples/ — built from the app's own modules (esbuild).
// 2. COMPILE: the engine wraps and compiles each one (artlux-engine --shader-check: naga GLSL → WGSL).
// 3. PICTURE: the engine renders each at 256×144 for three show times (--shader-render; feedback carries
//    across them), and the SAME program the app's wrapper builds is drawn in ArtLux's own Chromium exactly as
//    shaderContext.renderToBitmap draws it (WebGL2, premultiplied canvas, palette LUT on unit 0, history on
//    unit 1 copied after each draw). Gate: within 1 of 255 per channel — except shaders built on the
//    fract(sin(x) * 43758) hash, where one ulp of sin, amplified 43 758×, moves the grain: the app's own
//    picture already differs that way between GPUs (and between ANGLE's D3D11 and the engine's D3D12, with
//    the same HLSL — measured 2026-11-24). Those are reported, not gated.
// Scratch profile, its own process only. Needs the release engine (npm run build:engine).
const { spawn, execSync, execFileSync } = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const esbuild = require('esbuild');
const puppeteer = require('puppeteer-core');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const ROOT = path.resolve(__dirname, '..');
const fwd = (p) => p.split(path.sep).join('/');
const SRC = fwd(path.join(ROOT, 'plugins', 'shader', 'src'));
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-shader-parity.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', 'artlux-engine.exe');
const WORK = path.join(os.tmpdir(), 'artlux-shader-parity');
const PROFILE = path.join(WORK, 'profile');
const W = 256, H = 144;
const TIMES = [0.5, 1.0, 1.25];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.rmSync(WORK, { recursive: true, force: true }); fs.mkdirSync(WORK, { recursive: true });

// ── 1. the corpus ────────────────────────────────────────────────────────────────────────────────────
const entry = path.join(WORK, 'corpus-entry.ts');
fs.writeFileSync(entry, [
  `export { STARTERS, starterSource } from '${SRC}/starters';`,
  `export { RECIPES } from '${SRC}/cookbook';`,
  `export { EXAMPLES } from '${SRC}/nodeExamples';`,
  `export { generateGlsl } from '${SRC}/nodeGraph';`,
  `export { parseHeader, glslTypeOf } from '${SRC}/header';`,
  `export { buildProgramSource } from '${SRC}/wrapper';`,
  `export { buildPaletteLut } from '${fwd(path.join(ROOT, 'src', 'renderer', 'gpu', 'palettes'))}';`,
].join('\n'));
const bundle = path.join(WORK, 'corpus.cjs');
esbuild.buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error', alias: { '@': path.join(ROOT, 'src', 'renderer') } });
const m = require(bundle);
const list = [];
// Each input at its DEFAULT, one vec4 per input — shaderContext.nativeUniforms' packing.
const vec = (i) => { const v = i.def; switch (i.type) { case 'color': return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1]; case 'point2D': return [v[0] ?? 0, v[1] ?? 0, 0, 0]; case 'bool': return [v >= 0.5 ? 1 : 0, 0, 0, 0]; case 'long': case 'palette': return [Math.round(v), 0, 0, 0]; default: return [v, 0, 0, 0]; } };
const add = (name, source) => {
  if (!source) return;
  const h = m.parseHeader(source);
  list.push({ name, source, inputs: h.inputs.map((i) => ({ name: i.name, glsl: m.glslTypeOf(i.type) })), lastFrame: h.needsLastFrame, defaults: h.inputs.map(vec), prog: m.buildProgramSource(source) });
};
for (const s of m.STARTERS) add('starter:' + s.id, s.source);
for (const r of m.RECIPES) add('recipe:' + r.id, r.source);
for (const e of m.EXAMPLES) add('node:' + e.id, m.generateGlsl(e.graph).source);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => x.isDirectory() ? walk(path.join(d, x.name)) : x.name.endsWith('.artlux') ? [path.join(d, x.name)] : []);
for (const f of walk(path.join(ROOT, 'examples'))) {
  let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  for (const s of [...(d.surfaces ?? []), ...(d.scenes ?? []).flatMap((x) => x.surfaces ?? [])]) {
    if (s.content?.type === 'SHADER') add(`project:${path.basename(f)}:${s.name || s.id}`, s.content.shaderSource ?? m.starterSource(s.content.shaderId));
  }
}
const seen = new Set();
const corpus = list.filter((x) => !seen.has(x.source) && seen.add(x.source));
fs.writeFileSync(path.join(WORK, 'corpus.json'), JSON.stringify(corpus));
const lutRaw = m.buildPaletteLut();
const lut = { count: lutRaw.count, data: Array.from(lutRaw.data) };
console.log(`corpus: ${corpus.length} unique shaders`);

// ── 2. compile ───────────────────────────────────────────────────────────────────────────────────────
let failed = 0;
try {
  execFileSync(ENGINE, ['--shader-check', path.join(WORK, 'corpus.json')], { encoding: 'utf8' });
  console.log('compile: every shader compiles in the engine');
} catch (e) {
  console.log(String(e.stdout || e.message).split('\n').filter((l) => /FAIL|ERROR/.test(l)).join('\n'));
  failed++;
}

// ── 3. picture ───────────────────────────────────────────────────────────────────────────────────────
execFileSync(ENGINE, ['--shader-render', path.join(WORK, 'corpus.json'), path.join(WORK, 'engine'), '--size', `${W}x${H}`, '--times', TIMES.join(',')], { encoding: 'utf8' });
const hashNoise = (src) => /fract\s*\(\s*sin\s*\([\s\S]{0,80}?\)\s*\*\s*4375/.test(src);

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const env = { ...process.env, ARTLUX_CDP_PORT: '9334' }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`], { env, stdio: 'ignore' });
  try {
    let browser;
    for (let i = 0; i < 80 && !browser; i++) { try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9334', defaultViewport: null }); } catch { await sleep(250); } }
    if (!browser) throw new Error('the app never opened its debugging port');
    await sleep(6000);
    const page = (await browser.pages()).find((p) => /index\.html/.test(p.url()));
    const results = await page.evaluate((corpus, lut, W, H, TIMES) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      // shaderContext.ensure()'s options, exactly.
      const g = c.getContext('webgl2', { alpha: true, depth: false, stencil: false, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: false });
      const sh = (type, src) => { const s = g.createShader(type); g.shaderSource(s, src); g.compileShader(s); if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s)); return s; };
      const buf = g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER, buf);
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
      const pal = g.createTexture(); g.bindTexture(g.TEXTURE_2D, pal);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, 256, lut.count, 0, g.RGBA, g.UNSIGNED_BYTE, new Uint8Array(lut.data));
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
      g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.REPEAT); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
      const out = [];
      for (const s of corpus) {
        try {
          const p = g.createProgram();
          g.attachShader(p, sh(g.VERTEX_SHADER, s.prog.vert)); g.attachShader(p, sh(g.FRAGMENT_SHADER, s.prog.frag));
          g.bindAttribLocation(p, 0, 'aPos'); g.linkProgram(p);
          if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p));
          const vao = g.createVertexArray(); g.bindVertexArray(vao); g.bindBuffer(g.ARRAY_BUFFER, buf); g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
          let hist = null;
          if (s.lastFrame) {
            hist = g.createTexture(); g.bindTexture(g.TEXTURE_2D, hist); g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, W, H, 0, g.RGBA, g.UNSIGNED_BYTE, null);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
            g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
          }
          const frames = [];
          TIMES.forEach((t, n) => {
            g.viewport(0, 0, W, H); g.useProgram(p);
            const u = (k) => g.getUniformLocation(p, k);
            if (u('iResolution')) g.uniform3f(u('iResolution'), W, H, 1);
            if (u('iTime')) g.uniform1f(u('iTime'), t);
            if (u('iWallTime')) g.uniform1f(u('iWallTime'), t);
            if (u('iAspect')) g.uniform1f(u('iAspect'), W / H);
            if (u('iFrame')) g.uniform1i(u('iFrame'), n);
            if (u('artluxPaletteLut')) { g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, pal); g.uniform1i(u('artluxPaletteLut'), 0); if (u('artluxPaletteRows')) g.uniform1i(u('artluxPaletteRows'), lut.count); }
            s.inputs.forEach((inp, k) => {
              const loc = u(inp.name); if (!loc) return; const v = s.defaults[k];
              if (inp.glsl === 'vec4') g.uniform4f(loc, v[0], v[1], v[2], v[3]);
              else if (inp.glsl === 'vec2') g.uniform2f(loc, v[0], v[1]);
              else if (inp.glsl === 'int' || inp.glsl === 'bool') g.uniform1i(loc, v[0]);
              else g.uniform1f(loc, v[0]);
            });
            if (hist && u('lastFrame')) { g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, hist); g.uniform1i(u('lastFrame'), 1); }
            g.bindVertexArray(vao); g.drawArrays(g.TRIANGLES, 0, 3);
            const px = new Uint8Array(W * H * 4); g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
            if (hist) { g.activeTexture(g.TEXTURE1); g.bindTexture(g.TEXTURE_2D, hist); g.copyTexSubImage2D(g.TEXTURE_2D, 0, 0, 0, 0, 0, W, H); }
            // readPixels is bottom-up: turn it to row 0 at the top, as the bitmap and the engine hold it.
            const top = new Uint8Array(W * H * 4);
            for (let y = 0; y < H; y++) top.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
            frames.push(Array.from(top));
          });
          out.push({ ok: true, frames });
        } catch (e) { out.push({ ok: false, err: String(e.message || e).slice(0, 300) }); }
      }
      return out;
    }, corpus, lut, W, H, TIMES);
    browser.disconnect();
    results.forEach((r, k) => {
      const name = corpus[k].name;
      if (!r.ok) { console.log(`FAIL  ${name}: the app's WebGL refused it: ${r.err}`); failed++; return; }
      let worst = 0, over4 = 0, n = 0;
      r.frames.forEach((f, t) => {
        const e = fs.readFileSync(path.join(WORK, 'engine', `${k}-${t}.raw`));
        for (let i = 0; i < f.length; i++) { const d = Math.abs(f[i] - e[i]); if (d > worst) worst = d; if (d > 4) over4++; n++; }
      });
      const noise = hashNoise(corpus[k].source);
      if (worst > 1 && !noise) failed++;
      const tag = worst <= 1 ? 'SAME ' : noise ? 'HASH ' : 'FAIL ';
      console.log(`${tag} ${name.padEnd(44)} worst ${worst}${worst > 1 ? `, ${(100 * over4 / n).toFixed(2)}% of channels over 4${noise ? ' (sin-hash grain: reported, not gated)' : ''}` : ''}`);
    });
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
  }
  console.log(failed ? `\nshader parity: ${failed} FAILED` : '\nshader parity OK');
  process.exit(failed ? 1 : 0);
})();
