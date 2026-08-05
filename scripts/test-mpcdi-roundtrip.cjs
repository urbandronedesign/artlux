// Round-trip the MPCDI writer through its own reader, and through the real file on disk.
//
// The export and import halves live in one module and were never exercised together: `importMpcdi`
// had zero call sites until the calibration workbench grew an Import button, so "our writer emits
// what our parser expects" was an assumption. It is a regex over hand-built XML plus a hand-built
// PFM — exactly the shape that agrees with itself until one side is edited.
//
// Bundles src/main/mpcdi.ts with esbuild so the REAL functions are under test rather than a
// transcription. Run: node scripts/test-mpcdi-roundtrip.cjs [path-to-a-real.mpcdi]
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ARTLUX_ROOT || process.cwd();
const out = path.join(os.tmpdir(), `artlux-mpcdi-${process.pid}.cjs`);
execFileSync(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'),
  [path.join(ROOT, 'src/main/mpcdi.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${out}`],
  { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
const { buildMpcdi, parseMpcdi } = require(out);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1. synthetic round-trip, including the values most likely to be mangled ────────────────────
const W = 7, H = 5;
const xyz = new Float32Array(W * H * 3);
for (let i = 0; i < W * H; i++) {
  // Negative coordinates and a NaN hole: a venue sits around the origin, and NaN is how a miss is
  // spelled. Both survive or the map lies about where the projector points.
  if (i === 9) { xyz[i * 3] = NaN; xyz[i * 3 + 1] = NaN; xyz[i * 3 + 2] = NaN; continue; }
  xyz[i * 3] = -1.5 + i * 0.25; xyz[i * 3 + 1] = 2.75 - i * 0.125; xyz[i * 3 + 2] = i * 0.5;
}
const alpha = { w: 4, h: 3, data: Uint8Array.from({ length: 12 }, (_, i) => i * 20) };
const region = { id: 'proj-A', projW: 1920, projH: 1080, geo: { w: W, h: H, xyz }, alpha };

const buf = buildMpcdi([region], '2026-08-05T12:00:00');
const back = parseMpcdi(buf);
console.log('\nsynthetic round-trip');
check('one region survives', back.length === 1, `${back.length}`);
const r = back[0];
if (r) {
  check('id survives', r.id === 'proj-A', r.id);
  check('projector raster survives', r.projW === 1920 && r.projH === 1080, `${r.projW}x${r.projH}`);
  check('geometry grid survives', r.geo.w === W && r.geo.h === H, `${r.geo.w}x${r.geo.h}`);
  let maxErr = 0, nanOk = true;
  for (let i = 0; i < W * H * 3; i++) {
    if (Number.isNaN(xyz[i])) { if (!Number.isNaN(r.geo.xyz[i])) nanOk = false; continue; }
    maxErr = Math.max(maxErr, Math.abs(xyz[i] - r.geo.xyz[i]));
  }
  check('world positions survive exactly', maxErr === 0, `max |Δ| = ${maxErr}`);
  check('NaN misses stay NaN', nanOk, 'a miss that decodes as 0,0,0 would aim content at the origin');
  check('blend alpha survives', !!r.alpha && r.alpha.w === 4 && r.alpha.h === 3, r.alpha ? `${r.alpha.w}x${r.alpha.h}` : 'absent');
  if (r.alpha) {
    let aErr = 0;
    for (let i = 0; i < alpha.data.length; i++) aErr = Math.max(aErr, Math.abs(alpha.data[i] - r.alpha.data[i]));
    check('blend values survive', aErr === 0, `max |Δ| = ${aErr}`);
  }
}
check('the date we passed is the date written', /date="2026-08-05T12:00:00"/.test(buf.toString('latin1', 0, 400)), 'provenance is the point of the field');
check('a world map declares the 3D profile', /profile="3d"/.test(buf.toString('latin1', 0, 400)), 'and parses back as world');
check('kind round-trips as world', r && r.geo.kind === 'world', r ? String(r.geo.kind) : '-');

// ── 1b. the UV profile, which is what ArtLux actually writes now ───────────────────────────────
// The profile is not decoration: it tells a reader whether the three floats are a source coordinate
// or a point in the room. A consumer that guesses maps content to the wrong place, and both files
// parse, so only an explicit check catches a writer and reader drifting apart.
const uvRegion = { id: 'proj-B', projW: 1264, projH: 681, geo: { w: 4, h: 3, xyz: Float32Array.from({ length: 36 }, (_, i) => (i % 3 === 2 ? 0 : (i % 7) / 7)), kind: 'uv' } };
const uvBuf = buildMpcdi([uvRegion], '2026-08-05T12:00:00');
const uvBack = parseMpcdi(uvBuf)[0];
console.log('\nuv profile');
check('declares the 2D profile', /profile="2d"/.test(uvBuf.toString('latin1', 0, 400)), 'MPCDI 2d = output pixel -> source coordinate');
check('kind round-trips as uv', !!uvBack && uvBack.geo.kind === 'uv', uvBack ? String(uvBack.geo.kind) : 'no region');
if (uvBack) {
  let e = 0;
  for (let i = 0; i < uvRegion.geo.xyz.length; i++) e = Math.max(e, Math.abs(uvRegion.geo.xyz[i] - uvBack.geo.xyz[i]));
  check('uv values survive exactly', e === 0, `max |Δ| = ${e}`);
}

// ── 2. a real exported file, if one is offered ────────────────────────────────────────────────
const real = process.argv[2];
if (real && fs.existsSync(real)) {
  console.log(`\nreal file: ${path.basename(real)}`);
  const got = parseMpcdi(fs.readFileSync(real));
  check('parses', got.length > 0, `${got.length} region(s)`);
  for (const g of got) {
    let hits = 0;
    for (let i = 0; i < g.geo.xyz.length; i += 3) if (Number.isFinite(g.geo.xyz[i])) hits++;
    const n = g.geo.w * g.geo.h;
    console.log(`    ${g.id}: raster ${g.projW}x${g.projH}, grid ${g.geo.w}x${g.geo.h}, ${((100 * hits) / n).toFixed(1)}% covered`);
    check(`  ${g.id} has geometry`, hits > 0, `${hits}/${n}`);
  }
}

try { fs.unlinkSync(out); } catch { /* best effort */ }
console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m\n` : '\n\x1b[32mMPCDI round-trip OK\x1b[0m\n');
process.exit(failures ? 1 : 0);
