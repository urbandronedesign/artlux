#!/usr/bin/env node
// Diagnostic — the HLSL each side runs for the projector's plain warp (plans/native-engine.md, the soft-edge
// residue): ANGLE's, for the app's ProjectorGL (engine/spikes/hlsl-dump through WEBGL_debug_shaders), and
// naga's, for the engine (artlux-engine --dump-hlsl). Writes both into the work folder and prints where.
//
//   node scripts/dump-hlsl.cjs
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'artlux-hlsl-dump');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const page = path.join(WORK, 'page.js');
esbuild.buildSync({ entryPoints: [path.join(ROOT, 'engine', 'spikes', 'hlsl-dump', 'page.ts')], bundle: true, platform: 'browser', format: 'iife', outfile: page, logLevel: 'error' });
const env = { ...process.env, SPIKE_OUT: WORK, SPIKE_PAGE: page, SPIKE_SWITCHES: 'enable-privileged-webgl-extensions' };
delete env.ELECTRON_RUN_AS_NODE;
spawnSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(ROOT, 'engine', 'spikes', 'sampling-parity')], { env, stdio: 'ignore', timeout: 60000 });
const r = JSON.parse(fs.readFileSync(path.join(WORK, 'gpu-cases.json'), 'utf8'));
if (r.error) { console.log(`the page failed: ${r.error}`); process.exit(1); }
const ENGINE = process.env.ARTLUX_ENGINE_EXE || path.join(ROOT, 'engine', 'target', 'release', 'artlux-engine.exe');
execFileSync(ENGINE, ['--dump-hlsl', path.join(WORK, 'naga-warp.hlsl')], { stdio: 'inherit' });
console.log(`ANGLE (${r.renderer}): ${r.shaders.map((s) => `angle-${s.k}.hlsl (${s.bytes} B, from: ${s.glslHead.split('\n').find((l) => l.trim()) ?? ''})`).join('; ')}`);
console.log(`naga: naga-warp.hlsl`);
console.log(`in ${WORK}`);
