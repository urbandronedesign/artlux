#!/usr/bin/env node
// E2 — TEXT SURFACES ON THE WIRE (plans/native-engine.md "E2 text": a RASTER source — the app draws the
// type, ships the picture when it changes, the engine shows it).
//
//   node scripts/test-text-wire.cjs --packaged <ArtLux.exe>
//
// The app's Art-Net bytes (run A, no engine) against the engine's (run B, --native-engine: the engine owns
// the wire). Three text surfaces — a big word, a wrapped paragraph with a stroke, a rotated and scaled WHITE
// word — sampled by strips and serpentine matrices: IDENTICAL bytes expected on every universe, and every
// universe LIT (white on a 3-channel strip used to be black in BOTH runs — ledLayout.buildSegParams). Headless, SCRATCH profile (its own
// prefs carry the Art-Net target — the operator's are never touched), own process only.
const { spawn, execSync } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
if (process.platform !== 'win32') { console.log('Windows only — skipped'); process.exit(0); }
const pk = process.argv.indexOf('--packaged');
const EXE = pk > 0 ? path.resolve(process.argv[pk + 1]) : null;
if (!EXE) { console.error('usage: node scripts/test-text-wire.cjs --packaged <ArtLux.exe>'); process.exit(2); }
const PORT = 6492;
const WORK = path.join(os.tmpdir(), 'artlux-text-wire');
const PROFILE = path.join(WORK, 'profile');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(WORK, { recursive: true });

const project = path.join(WORK, 'text-wire.artlux');
const strip = (id, sid, uni, y) => ({ id, name: id, surfaceId: sid, x: 0.03, y, width: 0.9, height: 0.01, rotation: 0, ledCount: 150, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3 });
const matrix = (id, sid, uni, x, y) => ({ id, name: id, surfaceId: sid, x, y, width: 0.3, height: 0.2, rotation: 0, ledCount: 160, universe: uni, startAddress: 1, colorOrder: 'RGB', channelsPerPixel: 3, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true });
fs.writeFileSync(project, JSON.stringify({
  version: '1.2', timestamp: '2026-01-01T00:00:00.000Z',
  surfaces: [
    { id: 'sU', name: 'Word', x: 0.02, y: 0.02, width: 0.96, height: 0.3, rotation: 0, zIndex: 0, content: { type: 'TEXT', textBody: 'ARTLUX 42', textColor: '#ffcc00', textSize: 0.7, textWeight: 700, opacity: 1 } },
    { id: 'sP', name: 'Paragraph', x: 0.02, y: 0.36, width: 0.96, height: 0.3, rotation: 0, zIndex: 1, content: { type: 'TEXT', textBody: 'The quick brown fox jumps over the lazy dog, twice and then once more.', textWrap: true, textSize: 0.25, textColor: '#40c0ff', textStrokeColor: '#ff2060', textStrokeWidth: 0.02, textAlign: 'left', opacity: 1 } },
    { id: 'sM', name: 'Turned', x: 0.02, y: 0.7, width: 0.96, height: 0.28, rotation: 0, zIndex: 2, content: { type: 'TEXT', textBody: 'TURNED', textSize: 0.6, textWeight: 800, textRotate: 8, textScale: 1.2, textColor: '#ffffff', opacity: 1 } },
  ],
  fixtures: [strip('fU', 'sU', 0, 0.1), matrix('mU', 'sU', 1, 0.1, 0.05), strip('fP', 'sP', 2, 0.5), matrix('mP', 'sP', 3, 0.4, 0.4), strip('fM', 'sM', 4, 0.84)],
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
  const names = { 0: 'word strip', 1: 'word matrix', 2: 'paragraph strip', 3: 'paragraph matrix', 4: 'turned white strip' };
  for (const uni of [0, 1, 2, 3, 4]) {
    const a = A.last.get(uni), b = B.last.get(uni);
    if (!a || !b) { console.log(`FAIL universe ${uni} ${names[uni]}: missing (app ${!!a}, engine ${!!b})`); failed++; continue; }
    let max = 0, diff = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (d) diff++; }
    if (diff) failed++;
    // Identical BLACK would prove nothing: the type must actually reach the LEDs.
    const lit = a.filter((v) => v > 20).length;
    if (lit < 10) failed++;
    console.log(`${diff || lit < 10 ? 'FAIL ' : ''}universe ${uni} ${names[uni]}: ${diff} of ${a.length} channels differ, max ${max}, ${lit} channels lit${diff === 0 ? '  IDENTICAL' : ''}`);
  }
  console.log('sender ports (app run / engine run):', [...A.ports.values()][0], '/', [...B.ports.values()][0]);
  console.log(failed ? `\ntext wire: ${failed} FAILED` : '\ntext wire OK');
  process.exit(failed ? 1 : 0);
})();
