#!/usr/bin/env node
// npm run build:engine — the native engine (engine/), release.
//
// NDI (item 2b) is a cargo FEATURE because it links the NDI 6 SDK at build time: it is turned on here when
// the SDK is installed (NDI_SDK_DIR, which the SDK's installer sets) and left off otherwise — a CI runner or
// a machine without the SDK builds an engine with no NDI, which then refuses an NDI show so the app keeps it.
// Forced either way with ARTLUX_ENGINE_NDI=1 / 0.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const forced = process.env.ARTLUX_ENGINE_NDI;
const sdk = process.env.NDI_SDK_DIR && fs.existsSync(process.env.NDI_SDK_DIR);
const ndi = forced === '1' || (forced !== '0' && sdk);
const args = ['build', '--release', '--manifest-path', path.join(ROOT, 'engine', 'Cargo.toml'), '-p', 'artlux-engine', ...(ndi ? ['--features', 'ndi'] : [])];
console.log(`[build-engine] NDI ${ndi ? 'ON' : 'off'}${ndi ? '' : sdk === false && !forced ? ' (no NDI_SDK_DIR — the engine will leave NDI shows to the app)' : ''}`);
const r = spawnSync('cargo', args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
