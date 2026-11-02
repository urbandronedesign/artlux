#!/usr/bin/env node
/*
 * Stage the macOS NDI addon: native/ndi/macos/{ndi.node, libndi.dylib}, which package.json
 * `mac.extraResources` ships into Contents/Resources. Runs on macOS only (CI's macos job), after
 *   cargo build --release --features ndi --manifest-path native/ndi/Cargo.toml
 * with the NDI SDK for Apple installed.
 *
 * WHY THIS EXISTS. Until v0.35.0 NDI did not exist on a Mac at all: the only ndi.node was a committed
 * WINDOWS prebuilt, packaged for Windows only, and CI never built one for macOS — so every Mac install
 * started the NDI plugin as "unavailable", and nothing anywhere said so (2026-11-02).
 *
 * What a working Mac addon needs, each checked here rather than trusted:
 *   1. libndi.dylib shipped BESIDE ndi.node — a Mac without NDI Tools has no NDI library anywhere.
 *   2. ndi.node finding it there: its libndi reference must be `@rpath/libndi.dylib` and its rpath must
 *      include `@loader_path` (native/ndi/build.rs adds it; this repairs/asserts both with install_name_tool).
 *   3. An arm64 slice in libndi.dylib — the mac build target is Apple Silicon.
 *   4. Valid ad-hoc signatures: install_name_tool invalidates a signature, and on Apple Silicon an
 *      invalidly signed Mach-O is refused by the kernel (see verify-mac-signature.cjs). electron-builder
 *      re-signs the whole app afterwards; these signatures only have to hold for the load test below.
 *   5. It LOADS, and runtimeAvailable() is true — the same call the plugin makes at startup.
 *
 * Run:  node scripts/stage-ndi-macos.cjs     (no-op off macOS)
 */
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'darwin') {
  console.log('[stage-ndi-macos] not macOS — skipped');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const BUILT = path.join(ROOT, 'native', 'ndi', 'target', 'release', 'libartlux_ndi.dylib');
const OUT = path.join(ROOT, 'native', 'ndi', 'macos');
const fail = (msg) => { console.error(`[stage-ndi-macos] ${msg}`); process.exit(1); };
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

if (!fs.existsSync(BUILT)) fail(`no built addon at ${path.relative(ROOT, BUILT)} — run cargo build --release --features ndi first`);

// The SDK: NDI_SDK_DIR, else the installer's default folders (the same list grafton-ndi searches).
const sdkDirs = [process.env.NDI_SDK_DIR, '/Library/NDI SDK for Apple', '/Library/NDI SDK for macOS', '/Library/NDI 6 SDK']
  .filter((d) => d && fs.existsSync(d));
if (!sdkDirs.length) fail('NDI SDK for Apple not found (set NDI_SDK_DIR, or install Install_NDI_SDK_v6_Apple.pkg)');
const findDylib = (dir, depth = 0) => {
  if (depth > 5) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return findDylib(p, depth + 1);
    return e.name === 'libndi.dylib' ? [p] : [];
  });
};
const found = findDylib(sdkDirs[0]);
// Prefer the macOS library over an iOS / tvOS one the "for Apple" SDK also carries.
const lib = found.find((p) => /macos/i.test(p)) ?? found[0];
if (!lib) fail(`libndi.dylib not found under ${sdkDirs[0]}`);
console.log(`[stage-ndi-macos] SDK library: ${lib}`);

fs.mkdirSync(OUT, { recursive: true });
const node = path.join(OUT, 'ndi.node');
const dylib = path.join(OUT, 'libndi.dylib');
fs.copyFileSync(BUILT, node);
fs.copyFileSync(fs.realpathSync(lib), dylib); // the SDK ships symlinks; copy the real file

// 3. Apple Silicon slice.
const archs = sh('lipo', ['-archs', dylib]).trim();
console.log(`[stage-ndi-macos] libndi.dylib archs: ${archs}`);
if (!/\barm64\b/.test(archs)) fail('libndi.dylib has no arm64 slice — the mac build targets Apple Silicon');

// 2. The library's own id, and ndi.node's reference to it, both @rpath/libndi.dylib.
sh('install_name_tool', ['-id', '@rpath/libndi.dylib', dylib]);
const ref = sh('otool', ['-L', node]).split('\n').map((l) => l.trim().split(' ')[0]).find((l) => /libndi/.test(l));
if (!ref) fail('ndi.node does not reference libndi — was it built WITHOUT --features ndi? (the stub links nothing)');
if (ref !== '@rpath/libndi.dylib') {
  console.log(`[stage-ndi-macos] ndi.node referenced ${ref} — rewriting to @rpath/libndi.dylib`);
  sh('install_name_tool', ['-change', ref, '@rpath/libndi.dylib', node]);
}
const loadCmds = sh('otool', ['-l', node]);
if (!/path @loader_path\b/.test(loadCmds)) {
  console.log('[stage-ndi-macos] ndi.node had no @loader_path rpath — adding it (native/ndi/build.rs should have)');
  sh('install_name_tool', ['-add_rpath', '@loader_path', node]);
}

// 4. Re-sign after editing (ad hoc, as the app is).
for (const f of [dylib, node]) sh('codesign', ['--force', '--sign', '-', f]);

// 5. Load it the way the plugin does, in a fresh process, and ask for the runtime.
const probe = spawnSync(process.execPath, ['-e', `
  const m = require(${JSON.stringify(node)});
  console.log(JSON.stringify({ runtime: m.runtimeAvailable(), cpu: m.cpuSupported() }));
`], { encoding: 'utf8' });
if (probe.status !== 0) fail(`ndi.node did not load:\n${probe.stderr}`);
const res = JSON.parse(probe.stdout.trim().split('\n').pop());
console.log(`[stage-ndi-macos] loaded: runtimeAvailable=${res.runtime} cpuSupported=${res.cpu}`);
if (!res.runtime) fail('ndi.node loaded but the NDI runtime is NOT available — libndi.dylib was not found or failed to initialise');
console.log(`[stage-ndi-macos] staged → ${path.relative(ROOT, OUT)}/ (ndi.node + libndi.dylib)`);
