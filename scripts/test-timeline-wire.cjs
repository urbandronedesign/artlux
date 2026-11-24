#!/usr/bin/env node
// E3a — THE TIMELINE COMPOSITE ON THE WIRE (plans/native-engine.md E3a: the app evaluates the timeline, the
// engine draws each track's clip and composites them as compositeLayers does — engine comp.rs).
//
//   node scripts/test-timeline-wire.cjs --packaged <ArtLux.exe>
//
// The app's Art-Net bytes (run A, no engine) against the engine's (run B, --native-engine, the engine owns
// the wire). One timeline, three tracks of STILL content clips (the playhead rests at 0):
//   - top: a TEXT clip at content opacity 0.5 (the clip alpha is baked into its picture — fadedDrawable);
//   - middle: a still SHADER clip, the track at opacity 0.6 blended SCREEN;
//   - back: an IMAGE clip (a 1-px grid still), normal.
// Three surfaces read it: the PROGRAM (every track), a single LAYER (the faded text track alone) and a
// STACK of the shader and image tracks — each on a strip and a serpentine matrix. IDENTICAL bytes expected
// (within 1 where an 8-bit intermediate the app keeps and the engine does not can round differently), and
// every universe lit. Headless, SCRATCH profile, own processes only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-timeline-wire.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6494;
const WORK = path.join(os.tmpdir(), 'artlux-timeline-wire');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'timeline-wire.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
// The back track's still: a 1-px grid over a gradient (written as a PNG with the repo's pngjs).
const { PNG } = require(path.join(__dirname, '..', 'node_modules', 'pngjs'));
const png = new PNG({ width: 320, height: 180 });
for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) { const line = x % 20 === 0 || y % 15 === 0; png.data.set([line ? 255 : Math.round(x / 319 * 255), line ? 255 : 60, line ? 255 : Math.round(y / 179 * 255), 255], (y * 320 + x) * 4); }
const still = path.join(WORK, 'still.png'); fs.writeFileSync(still, PNG.sync.write(png));
const SHADER = 'vec4 shaderColor(vec2 uv) { return vec4(0.5 + 0.5 * sin(uv.x * 12.0), uv.y, 0.3, 1.0); }';
const clip = (id, layerId, content) => ({ id, layerId, name: id, path: '', content, start: 0, duration: 60, inPoint: 0 });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sP', name: 'Program', x: 0.02, y: 0.02, width: 0.96, height: 0.3, rotation: 0, zIndex: 0, content: { type: 'PROGRAM', opacity: 1 } },
    { id: 'sL', name: 'Text track', x: 0.02, y: 0.36, width: 0.96, height: 0.3, rotation: 0, zIndex: 1, content: { type: 'LAYER', layerId: 'L1', opacity: 1 } },
    { id: 'sS', name: 'Stack', x: 0.02, y: 0.7, width: 0.96, height: 0.28, rotation: 0, zIndex: 2, content: { type: 'LAYER', layerId: 'L2', layerIds: ['L2', 'L3'], opacity: 1 } },
  ],
  fixtures: [strip('fP', 'sP', 0, 0.17), matrix('mP', 'sP', 1, 0.1, 0.05), strip('fL', 'sL', 2, 0.51), matrix('mL', 'sL', 3, 0.4, 0.4), strip('fS', 'sS', 4, 0.84)],
  timeline: {
    duration: 60, fps: 30,
    layers: [
      { id: 'L1', name: 'Text', opacity: 1 },
      { id: 'L2', name: 'Shader', opacity: 0.6, blendMode: 'screen' },
      { id: 'L3', name: 'Still', opacity: 1 },
    ],
    clips: [
      clip('c1', 'L1', { type: 'TEXT', textBody: 'LAYER 1', textSize: 0.6, textWeight: 800, textColor: '#ffffff', opacity: 0.5 }),
      clip('c2', 'L2', { type: 'SHADER', shaderSource: SHADER, opacity: 1 }),
      clip('c3', 'L3', { type: 'IMAGE', url: still, opacity: 1 }),
    ],
  },
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
  const engineLines = B.log.split(/\r?\n/).filter((l) => /\[engine\].*(owns|keeps|raster|sources)/.test(l)).slice(0, 8);
  console.log(engineLines.join('\n'));
  let failed = 0;
  if (!/owns the wire/.test(B.log)) { console.log('FAIL: the engine never took the wire'); failed++; }
  const names = { 0: 'program strip', 1: 'program matrix', 2: 'text-track strip', 3: 'text-track matrix', 4: 'stack strip' };
  for (const uni of [0, 1, 2, 3, 4]) {
    const a = A.last.get(uni), b = B.last.get(uni);
    if (!a || !b) { console.log(`FAIL universe ${uni} ${names[uni]}: missing (app ${!!a}, engine ${!!b})`); failed++; continue; }
    let max = 0, diff = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d) diff++; }
    if (max > 1) failed++;
    // Identical BLACK would prove nothing: the type must actually reach the LEDs.
    const lit = a.filter((v) => v > 20).length;
    if (lit < 10) failed++;
    console.log(`${max > 1 || lit < 10 ? 'FAIL ' : ''}universe ${uni} ${names[uni]}: ${diff} of ${a.length} channels differ, max ${max}, ${lit} channels lit${diff === 0 ? '  IDENTICAL' : ''}`);
  }
  console.log('sender ports (app run / engine run):', [...A.ports.values()][0], '/', [...B.ports.values()][0]);
  console.log(failed ? `\ntimeline wire: ${failed} FAILED` : '\ntimeline wire OK');
  process.exit(failed ? 1 : 0);
})();
