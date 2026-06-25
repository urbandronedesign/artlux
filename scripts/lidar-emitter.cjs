// Synthetic LiDAR blob emitter — speaks the venue's 61fps OSC protocol to udp:10000.
// Lets you exercise the OSC Monitor (View ▸ OSC Monitor) and the whole tracking pipeline
// (3D Scene, projected blobs) without the real tracking server present.
//
//   node scripts/lidar-emitter.cjs [host] [port] [nBlobs]   # default 127.0.0.1 10000 2
//
// Each blob orbits its zone so motion/smoothing is visible. Ctrl+C to stop.
const dgram = require('node:dgram');

const HOST = process.argv[2] || '127.0.0.1';
const PORT = parseInt(process.argv[3] || '10000', 10);
const N = parseInt(process.argv[4] || '2', 10); // blobs per surface
const FPS = 61;

const sock = dgram.createSocket('udp4');

function padString(str) {
  const raw = Buffer.from(str, 'utf8');
  const len = (Math.floor(raw.length / 4) + 1) * 4; // null-terminate + 4-byte align
  const b = Buffer.alloc(len); raw.copy(b); return b;
}
// One arg per message: type 'i' (int) | 'f' (float), matching the venue protocol.
function osc(address, type, value) {
  const tags = padString(',' + type);
  const arg = Buffer.alloc(4);
  if (type === 'i') arg.writeInt32BE(value | 0); else arg.writeFloatBE(value);
  return Buffer.concat([padString(address), tags, arg]);
}
function fire(address, type, value) { sock.send(osc(address, type, value), PORT, HOST); }

// Zone dimensions (meters) per the protocol — 5.825 × 3.125 m.
const SCALE_X = 5.825, SCALE_Y = 3.125;

let t = 0;
function frame() {
  t += 1 / FPS;
  for (const surface of ['SOL', 'MUR']) {
    fire(`/${surface}/specs/Scalex`, 'f', SCALE_X);
    fire(`/${surface}/specs/Scaley`, 'f', SCALE_Y);
    for (let i = 0; i < N; i++) {
      const phase = t * (0.4 + i * 0.2) + i * 2.1 + (surface === 'MUR' ? Math.PI : 0);
      const u = 0.5 + 0.4 * Math.cos(phase);
      const v = 0.5 + 0.4 * Math.sin(phase * 1.3);
      fire(`/${surface}/blobs/blob${i}/id`, 'i', i + 1);
      fire(`/${surface}/blobs/blob${i}/tx`, 'f', (u - 0.5) * SCALE_X);
      fire(`/${surface}/blobs/blob${i}/ty`, 'f', (v - 0.5) * SCALE_Y);
      fire(`/${surface}/blobs/blob${i}/u`, 'f', u);
      fire(`/${surface}/blobs/blob${i}/v`, 'f', v);
    }
  }
}

console.log(`emitting ${N} blobs/surface (SOL+MUR) at ${FPS}fps -> ${HOST}:${PORT}  (Ctrl+C to stop)`);
const id = setInterval(frame, 1000 / FPS);
process.on('SIGINT', () => { clearInterval(id); sock.close(); process.exit(0); });
