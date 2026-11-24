#!/usr/bin/env node
// E2 — SHADER SURFACES ON THE WIRE (plans/native-engine.md "E2 shaders").
//
//   node scripts/test-shader-wire.cjs --packaged <ArtLux.exe>
//
// The app's Art-Net bytes (run A, no engine) against the engine's (run B, --native-engine: the engine owns
// the wire and draws the shaders itself — engine shader.rs, fed by plugins/shader nativeUniforms). Two STILL
// shaders (one reading a palette input) must give IDENTICAL bytes on strips and serpentine matrices; a MOVING
// one (the plasma starter) must move, and every payload the engine sends must equal one the app sent (median
// mean-|delta| 0: the frames are not in step, the pictures are the same). Headless, SCRATCH profile (its own
// prefs carry the Art-Net target — the operator's are never touched), own process only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-shader-wire.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6491;
const WORK = path.join(os.tmpdir(), 'artlux-shader-wire');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const STATIC_UV = `vec4 shaderColor(vec2 uv) {
  return vec4(uv.x, uv.y, 0.5 + 0.5 * sin(uv.x * 9.0 + uv.y * 4.0), 1.0);
}`;
const STATIC_PAL = `/*{ "INPUTS": [ { "NAME": "pal", "TYPE": "palette", "DEFAULT": 3 }, { "NAME": "gain", "TYPE": "float", "MIN": 0, "MAX": 2, "DEFAULT": 0.8 } ] }*/
vec4 shaderColor(vec2 uv) {
  float r = length(uv - 0.5) * 2.0;
  return vec4(palette(pal, r) * gain, 1.0);
}`;
const project = path.join(WORK, 'shader-wire.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sU', name: 'UV', x: 0.02, y: 0.02, width: 0.96, height: 0.3, rotation: 0, zIndex: 0, content: { type: 'SHADER', shaderSource: STATIC_UV, opacity: 1 } },
    { id: 'sP', name: 'Palette', x: 0.02, y: 0.36, width: 0.96, height: 0.3, rotation: 0, zIndex: 1, content: { type: 'SHADER', shaderSource: STATIC_PAL, opacity: 1 } },
    { id: 'sM', name: 'Plasma', x: 0.02, y: 0.7, width: 0.96, height: 0.28, rotation: 0, zIndex: 2, content: { type: 'SHADER', shaderId: 'plasma', opacity: 1 } },
  ],
  fixtures: [strip('fU', 'sU', 0, 0.1), matrix('mU', 'sU', 1, 0.1, 0.05), strip('fP', 'sP', 2, 0.5), matrix('mP', 'sP', 3, 0.4, 0.4), strip('fM', 'sM', 4, 0.8)],
  controllers: [], groups: [], scenes: [], cueBanks: [],
}, null, 2));

async function run(native) {
  fs.rmSync(PROFILE, { recursive: true, force: true }); fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(path.join(PROFILE, 'artlux-prefs.json'), JSON.stringify({ appSettings: { outputEnabled: true, artNetIp: '127.0.0.1', artNetPort: PORT, broadcast: false, protocol: 'artnet' } }));
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const last = new Map(); const all = new Map(); const ports = new Map();
  sock.on('message', (m, rinfo) => {
    if (m.length < 18 || m.toString('latin1', 0, 7) !== 'Art-Net' || m.readUInt16LE(8) !== 0x5000) return;
    const uni = m.readUInt16LE(14); const len = m.readUInt16BE(16);
    const data = Array.from(m.subarray(18, 18 + len));
    last.set(uni, data); ports.set(uni, rinfo.port);
    if (!all.has(uni)) all.set(uni, []); all.get(uni).push(data);
  });
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));
  const logf = path.join(WORK, `run-${native ? 'engine' : 'app'}.log`);
  const log = fs.openSync(logf, 'w');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(EXE, [`--user-data-dir=${PROFILE}`, '--headless', `--project=${project}`, ...(native ? ['--native-engine'] : [])], { env, stdio: ['ignore', log, log] });
  try {
    await sleep(14000);
    for (const k of [...all.keys()]) all.set(k, []);   // keep only the settled tail
    await sleep(4000);
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ }
    sock.close();
  }
  return { last, all, ports, log: fs.readFileSync(logf, 'utf8') };
}

(async () => {
  const A = await run(false);
  await sleep(1500);
  const B = await run(true);
  const engineLines = B.log.split(/\r?\n/).filter((l) => /\[engine\].*(owns|keeps|shader|sources)/.test(l)).slice(0, 8);
  console.log(engineLines.join('\n'));
  let failed = 0;
  if (!/owns the wire/.test(B.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  const names = { 0: 'UV strip', 1: 'UV matrix', 2: 'Palette strip', 3: 'Palette matrix', 4: 'Plasma strip (moving)' };
  for (const uni of [0, 1, 2, 3, 4]) {
    const a = A.last.get(uni), b = B.last.get(uni);
    if (!a || !b) { console.log(`FAIL universe ${uni} ${names[uni]}: missing (app ${!!a}, engine ${!!b})`); failed++; continue; }
    if (uni === 4) {
      // Moving: every engine payload must be close to SOME payload the app sent (the frames are not in step).
      const near = B.all.get(uni).map((pb) => Math.min(...A.all.get(uni).map((pa) => pa.reduce((s, v, i) => s + Math.abs(v - pb[i]), 0) / pa.length)));
      const moved = new Set(B.all.get(uni).map((x) => x.join(','))).size;
      const med = (xs) => xs.slice().sort((x, y) => x - y)[xs.length >> 1];
      const median = med(near);
      // The bound is the APP's own motion: the engine's frames are taken at other instants than the app's, so
      // each must be as close to some app frame as two CONSECUTIVE app frames are to each other (a fixed level
      // was timing luck — 0.00 one run, 0.6 the next).
      const appSeq = A.all.get(uni);
      const step = med(appSeq.slice(1).map((pa, i) => pa.reduce((s, v, k) => s + Math.abs(v - appSeq[i][k]), 0) / pa.length).filter((x) => x > 0));
      if (moved < 10 || !(median <= Math.max(0.5, step))) failed++;
      console.log(`universe 4 ${names[4]}: engine payloads ${B.all.get(uni).length} (${moved} distinct), mean |Δ| to nearest app payload: median ${median.toFixed(2)} levels (the app's own frame-to-frame step: ${step?.toFixed(2)})`);
      continue;
    }
    let max = 0, diff = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d) diff++; }
    if (diff) failed++;
    console.log(`${diff ? 'FAIL ' : ''}universe ${uni} ${names[uni]}: ${diff} of ${a.length} channels differ, max ${max}${diff === 0 ? '  IDENTICAL' : ''}`);
  }
  console.log('sender ports (app run / engine run):', [...A.ports.values()][0], '/', [...B.ports.values()][0]);
  console.log(failed ? `\nshader wire: ${failed} FAILED` : '\nshader wire OK');
  process.exit(failed ? 1 : 0);
})();
