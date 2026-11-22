#!/usr/bin/env node
// E1c WIRE PARITY: the same document through today's path and through the native engine, and the PACKETS
// compared — what an Art-Net node or an sACN receiver would actually get.
//
//   node scripts/test-wire-parity.cjs
//
// Three senders, one after the other, each into loopback listeners that record every UDP packet in order:
//   A. TODAY — packUniverses.ts → services/mockSocketService's targets → shared/frameCodec encodeFrame →
//      the SHIPPED addon native/output-engine/output-engine.node (pushFrame).
//   B. TODAY'S CODE, REBUILT — the same, through the addon built from the current source (the output engine
//      was split into core.rs + a Node front door for E1c; this proves the split changed no packet).
//   C. THE ENGINE — `artlux-engine --wire-replay`: Rust pack.rs → wire.rs → the SAME core.rs, linked without
//      Node.
// The frames: a few rigs routed to 127.0.0.1 (Art-Net and unicast sACN, two controllers + defaults), their
// colours changing frame to frame, some frames REPEATED (so sparse skipping decides what is sent), and
// ArtSync on for half the run. Keep-alive is off so every packet answers a frame that was pushed.
// USB (enttec) targets are not on loopback, and a broadcast flag on Art-Net changes a socket option, not a
// byte — both are covered byte for byte by test:pack-parity's frame comparison, which this complements.

const { execFile } = require('node:child_process');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'target', 'release', process.platform === 'win32' ? 'artlux-engine.exe' : 'artlux-engine');
const SHIPPED = path.join(ROOT, 'native', 'output-engine', 'output-engine.node');
const REBUILT_SRC = path.join(ROOT, 'native', 'output-engine', 'target', 'release', process.platform === 'win32' ? 'artlux_output_engine.dll' : 'libartlux_output_engine.so');
const WORK = path.join(os.tmpdir(), 'artlux-wire-parity');
fs.mkdirSync(WORK, { recursive: true });
const ARTNET_PORT = 6479;   // not 6454: never the app's own input socket
const SACN_PORT = 5568;     // fixed by the protocol (the output core sends sACN there)
const GAP_MS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
const bundle = path.join(WORK, 'wire-ts.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export { packUniverses, buildGammaLut } from './src/renderer/engine/packUniverses';
               export { encodeFrame } from './shared/frameCodec';`,
    resolveDir: ROOT, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error',
});
const TS = require(bundle);

// ── the frames ─────────────────────────────────────────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const r = rng(4242);
const controllers = [
  { id: 'cA', name: 'Node A', protocol: 'artnet', ip: '127.0.0.1', broadcast: false },
  { id: 'cS', name: 'sACN', protocol: 'sacn', ip: '127.0.0.1', broadcast: false, priority: 120 },
  // No priority: the frame's `?? 100` default must reach the sACN packet. Its own address (127.0.0.2, still
  // loopback): on 127.0.0.1 it would MERGE with cS into one destination, which takes the first fixture's
  // priority — and the default would never be on the wire.
  { id: 'cD', name: 'sACN default priority', protocol: 'sacn', ip: '127.0.0.2', broadcast: false },
];
const defaults = { protocol: 'artnet', ip: '127.0.0.1', broadcast: false };
function rig(seed) {
  const rr = rng(seed);
  return Array.from({ length: 6 }, (_, i) => ({
    id: `f${seed}_${i}`, name: `F${i}`, x: 0, y: 0, width: 0.1, height: 0.01, rotation: 0, reverse: false, colorData: [],
    universe: Math.floor(rr() * 3), startAddress: 1 + Math.floor(rr() * 400), ledCount: [10, 60, 170, 200][Math.floor(rr() * 4)],
    channelsPerPixel: rr() < 0.5 ? 3 : 4, colorOrder: ['RGB', 'GRB', 'BGR'][Math.floor(rr() * 3)],
    controllerId: [undefined, 'cA', 'cS', 'cD'][Math.floor(rr() * 4)],
    output: rr() < 0.2 ? { sparse: true } : undefined,
  }));
}
const frames = [];
for (let k = 0; k < 4; k++) {
  const fixtures = rig(100 + k);
  const leds = fixtures.reduce((a, f) => a + f.ledCount, 0);
  let raw = new Uint8Array(leds * 4);
  for (let n = 0; n < 12; n++) {
    // Every third frame repeats the last one, so the sparse path has something to skip.
    if (n % 3 !== 2) { raw = raw.slice(); for (let i = 0; i < raw.length; i++) if (r() < 0.3) raw[i] = Math.floor(r() * 256); }
    frames.push({ name: `rig ${k} frame ${n}`, defaults, gamma: k % 2 ? 2.2 : 1, controllers, fixtures, raw: Array.from(raw), port: ARTNET_PORT });
  }
}

// ── capture ────────────────────────────────────────────────────────────────────────────────────────────
async function capture(send) {
  const got = { artnet: [], sacn: [], sacn2: [] };
  const socks = await Promise.all([['artnet', ARTNET_PORT, '127.0.0.1'], ['sacn', SACN_PORT, '127.0.0.1'], ['sacn2', SACN_PORT, '127.0.0.2']].map(([k, port, host]) => new Promise((res, rej) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    s.on('message', (m) => got[k].push(m.toString('hex')));
    s.on('error', rej);
    s.bind(port, host, () => { try { s.setRecvBufferSize(4 << 20); } catch { /* best effort */ } res(s); });
  })));
  await send();
  await sleep(500);
  for (const s of socks) s.close();
  return got;
}
async function viaAddon(file) {
  // A fresh copy per run: a napi addon is loaded once per process, so two loads of the SAME path would
  // share one engine — and its per-universe sequence numbers.
  const copy = path.join(WORK, `addon-${path.basename(path.dirname(file))}-${Date.now()}.node`);
  fs.copyFileSync(file, copy);
  const addon = require(copy);
  return capture(async () => {
    addon.configure(false, 44, false, frames.some(() => true) && SYNC);
    for (const f of frames) {
      const dests = TS.packUniverses(Uint8Array.from(f.raw), f.fixtures, {
        controllerMap: new Map(f.controllers.map((c) => [c.id, c])), defaults: f.defaults,
        gammaLut: TS.buildGammaLut(f.gamma), pool: {}, packLight: () => {},
      });
      const targets = Object.values(dests).map((d) => ({ ip: d.ip, port: f.port, protocol: d.protocol, broadcast: d.broadcast, sparse: d.sparse, priority: d.priority, universes: d.universes }));
      addon.pushFrame(Buffer.from(TS.encodeFrame(targets)));
      await sleep(GAP_MS);
    }
    await sleep(300);
    addon.close();
  });
}
async function viaEngine() {
  const inp = path.join(WORK, `replay-${SYNC ? 'sync' : 'nosync'}.json`);
  fs.writeFileSync(inp, JSON.stringify({ sync: SYNC, gapMs: GAP_MS, frames }));
  // ASYNC, not execFileSync: a blocked event loop reads no packet while the engine sends, the socket's
  // receive buffer fills, and the tail of the run is dropped — the first version of this test reported
  // exactly that as an engine failure.
  return capture(() => new Promise((res, rej) => {
    execFile(ENGINE, ['--wire-replay', inp], (err) => (err ? rej(err) : res()));
  }));
}

let SYNC = false;
(async () => {
  if (!fs.existsSync(ENGINE)) { console.error(`no engine at ${ENGINE} — npm run build:engine`); process.exit(2); }
  const senders = [['A shipped addon', () => viaAddon(SHIPPED)]];
  if (fs.existsSync(REBUILT_SRC)) senders.push(['B rebuilt addon', () => viaAddon(REBUILT_SRC)]);
  else console.log(`(no rebuilt addon at ${REBUILT_SRC} — cargo build --release in native/output-engine for sender B)`);
  senders.push(['C engine', viaEngine]);
  let fails = 0;
  for (const sync of [false, true]) {
    SYNC = sync;
    const runs = [];
    for (const [name, fn] of senders) runs.push([name, await fn()]);
    const [refName, ref] = runs[0];
    console.log(`ArtSync ${sync ? 'ON' : 'off'}: ${refName} sent ${ref.artnet.length} Art-Net + ${ref.sacn.length} + ${ref.sacn2.length} sACN packets (${frames.length} frames)`);
    if (!ref.artnet.length || !ref.sacn.length || !ref.sacn2.length) { fails++; console.log('   FAIL the reference sent nothing on one protocol — the test proves nothing'); }
    for (const [name, got] of runs.slice(1)) {
      for (const k of ['artnet', 'sacn', 'sacn2']) {
        const a = ref[k], b = got[k];
        const at = a.findIndex((p, i) => p !== b[i]);
        const same = a.length === b.length && at < 0;
        if (!same) fails++;
        console.log(`   ${same ? 'ok  ' : 'FAIL'} ${name} — ${k}: ${b.length} packets${same ? ', identical in order and bytes' : `, first difference at packet ${at < 0 ? a.length : at}`}`);
      }
    }
  }
  console.log(fails ? 'WIRE PARITY FAILED' : 'WIRE PARITY OK');
  process.exit(fails ? 1 : 0);
})();
