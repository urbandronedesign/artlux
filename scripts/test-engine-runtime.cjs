#!/usr/bin/env node
// E1f-1 THE ENGINE AT RUNTIME: `artlux-engine --serve` fed a document and ticks over stdio, exactly as main
// feeds it (src/main/engineHost.ts), and what it puts ON THE WIRE captured on loopback.
//
//   node scripts/test-engine-runtime.cjs
//
// Held to the proven pieces: for the same document at the same show time, every Art-Net universe the
// running engine sends must carry the bytes of `--frame-once` (E1d, held to the app) packed by the app's
// REAL TypeScript packer (packUniverses.ts, E1b). And the runtime's own rules:
//   - LIGHTS (E1f-2): their channel bytes arrive in each tick and are placed as the app's packer places them;
//   - OWNERSHIP: a surface the engine cannot draw, or output switched off → "owns": false
//     with the reason, and NOTHING on the wire; a drawable document → owns, and sends.
//   - HANDBACK: after losing ownership the send thread is emptied — keep-alive ON, and still silence.
//   - CACHING does not freeze a picture: a new document with another opacity changes the bytes.
//   - pings are answered while it renders (main's hang detector must never see a busy engine as hung).

const { execFileSync, spawn } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const WORK = path.join(os.tmpdir(), 'artlux-engine-runtime');
fs.mkdirSync(WORK, { recursive: true });
const PORT = 6481;   // not 6454: never the app's own input socket
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { PNG } = require(path.join(ROOT, 'node_modules', 'pngjs'));
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const bundle = path.join(WORK, 'ts.cjs');
esbuild.buildSync({ stdin: { contents: `export { packUniverses, buildGammaLut } from './src/renderer/engine/packUniverses';`, resolveDir: ROOT, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error' });
const TS = require(bundle);

// ── the document ───────────────────────────────────────────────────────────────────────────────────────
function writePng(name, w, h, px) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y); const i = (y * w + x) * 4; png.data.set([c[0], c[1], c[2], 255], i); }
  const f = path.join(WORK, name); fs.writeFileSync(f, PNG.sync.write(png)); return f;
}
const imgA = writePng('a-800x450.png', 800, 450, (x, y) => (x % 53 === 0 ? [255, 255, 255] : [Math.round(x / 799 * 255), Math.round(y / 449 * 255), 90]));
const imgB = writePng('b-320x320.png', 320, 320, (x, y) => [((x >> 4) + (y >> 4)) % 2 ? 230 : 20, 120, Math.round(x / 319 * 255)]);
const surfaces = [
  { id: 'sA', name: 'A', x: 0.05, y: 0.05, width: 0.4, height: 0.4, rotation: 0, zIndex: 0, content: { type: 'IMAGE', url: imgA } },
  { id: 'sB', name: 'B', x: 0.55, y: 0.05, width: 0.4, height: 0.4, rotation: 0, zIndex: 1, content: { type: 'IMAGE', url: imgB, opacity: 0.7 } },
  { id: 'sW', name: 'Wave', x: 0.05, y: 0.55, width: 0.4, height: 0.4, rotation: 0, zIndex: 2, content: { type: 'EFFECT', effectId: 3, paletteId: 2, speed: 0.6, intensity: 0.4 } },
];
const base = { rotation: 0, reverse: false, colorData: [], startAddress: 1 };
const fixtures = [
  { ...base, id: 'fA', name: 'A strip', surfaceId: 'sA', x: 0.06, y: 0.2, width: 0.38, height: 0.004, ledCount: 170, universe: 0 },
  { ...base, id: 'fB', name: 'B matrix', surfaceId: 'sB', x: 0.57, y: 0.07, width: 0.36, height: 0.36, ledCount: 16 * 10, universe: 1, shape: 'MATRIX', matrixWidth: 16, matrixHeight: 10, serpentine: true, colorOrder: 'GRB' },
  { ...base, id: 'fW', name: 'Wave strip', surfaceId: 'sW', x: 0.06, y: 0.7, width: 0.38, height: 0.004, ledCount: 120, universe: 2, channelsPerPixel: 4 },
];
const controllers = [];
const defaults = { protocol: 'artnet', ip: '127.0.0.1', broadcast: false };
const sources = { sA: { kind: 'image', path: imgA }, sB: { kind: 'image', path: imgB }, sW: { kind: 'effect' } };
const T = 1.25, GAMMA = 2.2;
const doc = (rev, over = {}) => ({ rev, fixtures, surfaces, controllers, defaults, gamma: GAMMA, port: PORT, outputEnabled: true, sources, lights: [], ...over });
// E1f-2 LIGHTS: a head patched mid-universe, one that SPILLS past channel 512 into the next universe, and one
// the host could not describe (no bytes sent: it must write nothing). The host sends their bytes per tick.
const lightFix = [
  { ...{ rotation: 0, reverse: false, colorData: [] }, id: 'L1', name: 'Head 1', ledCount: 1, universe: 5, startAddress: 101, profileId: 'generic/rgbw-fader' },
  { ...{ rotation: 0, reverse: false, colorData: [] }, id: 'L2', name: 'Head 2', ledCount: 1, universe: 5, startAddress: 509, profileId: 'generic/generic-5ch' },
  { ...{ rotation: 0, reverse: false, colorData: [] }, id: 'L3', name: 'Unknown', ledCount: 1, universe: 5, startAddress: 300, profileId: 'nobody/unknown' },
];
const lightBytesAt = (k) => ({ L1: [k * 7 % 256, 255, 0, 128, 64], L2: [1, 2, 3, 4, (k * 31) % 256] });

// What the wire must carry: --frame-once at T, packed by the app's own packer.
function expectedUniverses(d, lights = {}) {
  const proj = path.join(WORK, `exp-${d.rev}.artlux`), out = path.join(WORK, `exp-${d.rev}.json`);
  fs.writeFileSync(proj, JSON.stringify({ surfaces: d.surfaces, fixtures: d.fixtures }));
  execFileSync(ENGINE, ['--frame-once', proj, out, '--effect-times', String(T)]);
  const raw = Buffer.from(JSON.parse(fs.readFileSync(out, 'utf8')).rgbw, 'base64');
  const dests = TS.packUniverses(Uint8Array.from(raw), d.fixtures, { controllerMap: new Map(), defaults, gammaLut: TS.buildGammaLut(GAMMA), pool: {}, packLight: (f, w) => { for (const v of lights[f.id] || []) w(v); } });
  const u = {}; for (const dd of Object.values(dests)) for (const [k, v] of Object.entries(dd.universes)) u[k] = Buffer.from(v);
  return u;
}

(async () => {
  let fails = 0;
  const ok = (c, m) => { if (!c) fails++; console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`); };
  const sock = dgram.createSocket('udp4');
  let packets = [];
  sock.on('message', (m) => { if (m.toString('latin1', 0, 7) === 'Art-Net' && m.readUInt16LE(8) === 0x5000) packets.push({ at: Date.now(), u: m.readUInt16LE(14), data: m.subarray(18, 18 + m.readUInt16BE(16)) }); });
  await new Promise((r) => sock.bind(PORT, '127.0.0.1', r));

  const eng = spawn(ENGINE, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  eng.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  let err = ''; eng.stderr.on('data', (d) => { err += d; });
  const send = (o) => eng.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = async (pred, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const l = lines.find(pred); if (l) return l; await sleep(20); } return null; };
  const hello = await waitFor((l) => l.type === 'hello');
  ok(!!hello, `the engine said hello (${hello?.adapter})`);

  send({ type: 'output', broadcast: false, fps: 44, keepAlive: true, sync: false });
  // ── 1. a drawable document: owns, and the wire carries exactly the proven frame ─────────────────────────
  const d1 = doc(1);
  send({ type: 'doc', doc: d1 });
  const o1 = await waitFor((l) => l.type === 'owns' && l.rev === 1);
  ok(o1?.owns === true, `document 1 (two stills + a Wave effect): the engine OWNS the wire${o1?.why ? ` — ${o1.why}` : ''}`);
  packets = [];
  let pongs = 0;
  for (let k = 0; k < 20; k++) { send({ type: 'tick', rev: 1, t: T, brightness: 1 }); if (k % 5 === 0) send({ ping: k }); await sleep(25); }
  await sleep(300);
  pongs = lines.filter((l) => l.type === 'pong').length;
  ok(pongs === 4, `pings answered while it renders (${pongs}/4)`);
  const exp1 = expectedUniverses(d1);
  for (const [u, want] of Object.entries(exp1)) {
    const got = packets.filter((p) => p.u === Number(u));
    const last = got[got.length - 1];
    ok(last && Buffer.compare(last.data, want) === 0, `universe ${u}: ${got.length} packets, the last ${last ? (Buffer.compare(last.data, want) === 0 ? 'IDENTICAL to --frame-once + the app\'s packer' : `DIFFERENT (${last.data.length} vs ${want.length} bytes)`) : 'never sent'}`);
  }

  // ── 2. caching does not freeze a picture: another opacity → other bytes, still the proven ones ──────────
  const d2 = doc(2, { surfaces: surfaces.map((s) => (s.id === 'sB' ? { ...s, content: { ...s.content, opacity: 0.3 } } : s)) });
  send({ type: 'doc', doc: d2 });
  await waitFor((l) => l.type === 'owns' && l.rev === 2);
  packets = [];
  for (let k = 0; k < 8; k++) { send({ type: 'tick', rev: 2, t: T, brightness: 1 }); await sleep(25); }
  await sleep(300);
  const exp2 = expectedUniverses(d2);
  const b2 = packets.filter((p) => p.u === 1).pop();
  ok(b2 && Buffer.compare(b2.data, exp2[1]) === 0 && Buffer.compare(exp2[1], exp1[1]) !== 0, 'a new opacity on a cached still reaches the wire (and is the proven frame)');

  // ── 3. ownership refused: and nothing more on the wire — even with keep-alive ON ────────────────────────
  const refusals = [
    ['an unsupported source', doc(4, { sources: { ...sources, sB: { kind: 'unsupported', why: 'MP4 is decoded in the browser' } } }), /surface 'B': MP4 is decoded in the browser/],
    ['output off', doc(5, { outputEnabled: false }), /output is off/],
  ];
  for (const [what, d, why] of refusals) {
    send({ type: 'doc', doc: d });
    const o = await waitFor((l) => l.type === 'owns' && l.rev === d.rev);
    ok(o && o.owns === false && why.test(o.why), `${what}: does NOT own — "${o?.why}"`);
    await sleep(150);
    packets = [];
    for (let k = 0; k < 6; k++) { send({ type: 'tick', rev: d.rev, t: T, brightness: 1 }); await sleep(25); }
    await sleep(1500);   // longer than the keep-alive interval
    ok(packets.length === 0, `${what}: silent on the wire for 1.6 s, keep-alive on (${packets.length} packets)`);
    // Back to a drawable document before the next refusal, so each one is a HANDBACK from owning.
    send({ type: 'doc', doc: doc(d.rev + 100) });
    await waitFor((l) => l.type === 'owns' && l.rev === d.rev + 100);
    for (let k = 0; k < 4; k++) { send({ type: 'tick', rev: d.rev + 100, t: T, brightness: 1 }); await sleep(25); }
  }

  // ── 3b. LIGHTS (E1f-2): driven, not refused — each tick's bytes placed exactly as the app's packer does ──
  {
    const dl = doc(20, { fixtures: [...fixtures, ...lightFix], lights: lightFix.map((f) => f.id) });
    send({ type: 'doc', doc: dl });
    const o = await waitFor((l) => l.type === 'owns' && l.rev === 20);
    ok(o?.owns === true, `a rig with light fixtures: the engine OWNS the wire${o?.why ? ` — ${o.why}` : ''}`);
    for (const k of [1, 2]) {
      await sleep(100); packets = [];
      for (let n = 0; n < 6; n++) { send({ type: 'tick', rev: 20, t: T, brightness: 1, lights: lightBytesAt(k) }); await sleep(25); }
      await sleep(250);
      const exp = expectedUniverses(dl, lightBytesAt(k));
      for (const u of [5, 6]) {
        const got = packets.filter((p) => p.u === u).pop();
        ok(got && exp[u] && Buffer.compare(got.data, exp[u]) === 0, `lights, tick set ${k}: universe ${u} ${got && exp[u] ? (Buffer.compare(got.data, exp[u]) === 0 ? 'IDENTICAL to the app packer' : 'DIFFERENT') : 'missing'}${u === 6 ? ' (Head 2 spills into it)' : ''}`);
      }
      const pix = packets.filter((p) => p.u === 0).pop();
      ok(pix && Buffer.compare(pix.data, exp[0]) === 0, `lights, tick set ${k}: the pixel universe 0 is unchanged by the lights`);
    }
    const u5 = expectedUniverses(dl, lightBytesAt(1))[5];
    ok(u5.subarray(299, 304).every((b) => b === 0), 'the light with no bytes (an unknown profile) writes nothing');
  }

  // ── 4. a tick for an OLD document draws nothing ───────────────────────────────────────────────────────
  send({ type: 'doc', doc: doc(9) });
  await waitFor((l) => l.type === 'owns' && l.rev === 9);
  await sleep(300); packets = [];
  send({ type: 'output', broadcast: false, fps: 44, keepAlive: false, sync: false });
  await sleep(100); packets = [];
  for (let k = 0; k < 5; k++) { send({ type: 'tick', rev: 8, t: T, brightness: 1 }); await sleep(25); }
  await sleep(300);
  ok(packets.length === 0, `ticks naming an old document send nothing (${packets.length})`);

  eng.stdin.write('{"quit":true}\n');
  const code = await new Promise((r) => eng.on('exit', r));
  ok(code === 0, `quit: exit ${code}`);
  if (err.trim()) console.log(`--- engine stderr:\n${err.trim()}`);
  sock.close();
  console.log(fails ? `\nENGINE RUNTIME FAILED: ${fails}` : '\nENGINE RUNTIME OK');
  process.exit(fails ? 1 : 0);
})();
