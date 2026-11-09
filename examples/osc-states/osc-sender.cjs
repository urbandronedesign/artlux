#!/usr/bin/env node
// osc-sender.cjs — pretend to be two OSC devices on this computer and drive osc-states.artlux.
//
//   node examples/osc-states/osc-sender.cjs            interactive: press keys, watch the show move
//   node examples/osc-states/osc-sender.cjs demo       scripted: walks every case, with narration
//
// Options:  --host 127.0.0.1   where ArtLux listens (default this computer)
//           --port 10000       ArtLux's OSC listen port (Preferences ▸ OSC / Tracking)
//
// TWO DEVICES, TWO FIXED SOURCE PORTS. A state trigger can be limited to one named sender, and a sender
// is an IP + the port it sends FROM. So this script binds:
//   · "Tablet"   → 127.0.0.1:9001 — the device the project's bindings name
//   · "Intruder" → 127.0.0.1:9002 — anybody else on the network; its /show/next must be ignored
//
// No dependencies: a minimal OSC 1.0 encoder (address + type tags + int32 / no args) is below.

const dgram = require('node:dgram');
const readline = require('node:readline');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const HOST = arg('--host', '127.0.0.1');
const PORT = parseInt(arg('--port', '10000'), 10);
const DEMO = process.argv.includes('demo');

// ── OSC encoding ────────────────────────────────────────────────────────────────────────────────
const pad = (s) => { const b = Buffer.from(s + '\0'); return Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]); };
function encode(address, int) {
  if (int === undefined) return Buffer.concat([pad(address), pad(',')]);
  const v = Buffer.alloc(4); v.writeInt32BE(int);
  return Buffer.concat([pad(address), pad(',i'), v]);
}

// ── the two "devices" ───────────────────────────────────────────────────────────────────────────
const devices = { Tablet: 9001, Intruder: 9002 };
const socks = {};
function open() {
  return Promise.all(Object.entries(devices).map(([name, port]) => new Promise((res, rej) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (e) => rej(new Error(`${name}: cannot bind 127.0.0.1:${port} (${e.code}) — is another copy of this script running?`)));
    s.bind(port, '127.0.0.1', () => { socks[name] = s; res(); });
  })));
}
function send(device, address, int) {
  socks[device].send(encode(address, int), PORT, HOST);
  const a = int === undefined ? '' : ` ${int}`;
  console.log(`  → ${device.padEnd(8)} (127.0.0.1:${devices[device]})  ${address}${a}`);
}
// A button: 1 on press, 0 on release — what TouchOSC sends. Only the press fires.
const tap = (device, address) => { send(device, address, 1); setTimeout(() => send(device, address, 0), 120); };

// ── scripted demo ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function demo() {
  const step = async (say, fn, wait = 3500) => { console.log(`\n${say}`); fn(); await sleep(wait); };
  console.log(`Sending to ${HOST}:${PORT}. Watch the state lane / the stage in ArtLux.`);
  await step('1. Intruder taps /show/next — not the Tablet, so nothing happens (still Idle).', () => tap('Intruder', '/show/next'));
  await step('2. Tablet taps /show/next — Idle → Show (1.5 s fade). The release (0) does not fire a second time.', () => tap('Tablet', '/show/next'));
  await step('3. Tablet taps /show/next again — Show → Finale.', () => tap('Tablet', '/show/next'));
  await step('4. Intruder taps /show/home — the home rule accepts ANY sender: → Idle (2 s fade).', () => tap('Intruder', '/show/home'));
  await step('5. Tablet taps /show/finale — the OSC jump: straight to Finale, no fade, from Idle.', () => tap('Tablet', '/show/finale'));
  await step('6. Tablet taps /show/next while in Finale — no edge leaves Finale on it, so it is DROPPED…', () => tap('Tablet', '/show/next'), 1000);
  await step('   …and Tablet taps /show/home — → Idle. The /show/next from step 6 does NOT fire now.', () => tap('Tablet', '/show/home'), 4000);
  console.log('\nDone — the show should be in Idle.');
}

// ── interactive ─────────────────────────────────────────────────────────────────────────────────
function interactive() {
  console.log(`Sending to ${HOST}:${PORT}.
  n  Tablet   /show/next     advance Idle → Show → Finale
  f  Tablet   /show/finale   OSC jump to Finale (no fade)
  h  Tablet   /show/home     back to Idle (global rule)
  i  Intruder /show/next     wrong sender — ignored
  j  Intruder /show/home     home accepts any sender — works
  q  quit`);
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const keys = {
    n: () => tap('Tablet', '/show/next'), f: () => tap('Tablet', '/show/finale'), h: () => tap('Tablet', '/show/home'),
    i: () => tap('Intruder', '/show/next'), j: () => tap('Intruder', '/show/home'),
  };
  process.stdin.on('keypress', (_s, key) => {
    if (!key) return;
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) { close(); return; }
    keys[key.name]?.();
  });
}

function close() { for (const s of Object.values(socks)) s.close(); process.exit(0); }

open().then(() => (DEMO ? demo().then(close) : interactive())).catch((e) => { console.error(e.message); process.exit(1); });
