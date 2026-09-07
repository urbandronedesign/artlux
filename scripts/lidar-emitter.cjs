// Synthetic LiDAR blob emitter — speaks the venue's 61fps OSC protocol to udp:10000.
// Lets you exercise the OSC Monitor (View ▸ OSC Monitor) and the whole tracking pipeline
// (3D Scene, projected blobs) without the real tracking server present.
//
//   node scripts/lidar-emitter.cjs [host] [port] [nBlobs] [--pairs]   # default 127.0.0.1 10000 2
//
// Each blob orbits its zone so motion/smoothing is visible. Ctrl+C to stop.
//
// ── --pairs: EMIT EACH PERSON AS TWO BLOBS, LIKE THE ACTUAL VENUE ────────────────────────────────
// The installed LiDAR reports ~2 blobs per person, each with its own id — so anything counting raw
// blobs counts double, and a zone asking for two visitors needs four. The default single-blob mode
// cannot reproduce that, which is why it went unnoticed here and was found on site instead.
//
// With --pairs, `nBlobs` is a number of PEOPLE and each one emits two blobs ~0.3 m apart (well inside
// the 0.8 m default merge radius). That makes the whole chain testable off-site:
//
//   node scripts/lidar-emitter.cjs 127.0.0.1 10000 2 --pairs
//     → 4 blobs, 2 people. Trigger Zones must read "4 blobs → 2 people" with Merge people ON,
//       and a zone set to 2 people must latch. With merging OFF it reads "4 blobs · merge off"
//       and that same zone latches for ONE visitor — the bug, on demand.
const dgram = require('node:dgram');

const ARGV = process.argv.slice(2).filter((a) => a !== '--pairs');
const PAIRS = process.argv.includes('--pairs');
const HOST = ARGV[0] || '127.0.0.1';
const PORT = parseInt(ARGV[1] || '10000', 10);
const N = parseInt(ARGV[2] || '2', 10); // blobs per surface, or PEOPLE per surface with --pairs
const FPS = 61;
// Half the gap between a person's two blobs, in metres. 0.3 m apart total — a stride, and comfortably
// inside the 0.8 m default merge radius so the merge is exercised rather than defeated.
const HALF_GAP_M = 0.15;

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
    let slot = 0;
    for (let i = 0; i < N; i++) {
      const phase = t * (0.4 + i * 0.2) + i * 2.1 + (surface === 'MUR' ? Math.PI : 0);
      const u = 0.5 + 0.4 * Math.cos(phase);
      const v = 0.5 + 0.4 * Math.sin(phase * 1.3);
      // One person → one blob, or two straddling them. The offset is along the path's normal so a
      // walking pair stays side-by-side rather than strung out along the direction of travel.
      const offs = PAIRS ? [-HALF_GAP_M, +HALF_GAP_M] : [0];
      for (const off of offs) {
        const tx = (u - 0.5) * SCALE_X + off;
        const ty = (v - 0.5) * SCALE_Y;
        // Each blob carries its OWN id — that is the venue's behaviour and the whole reason a raw
        // count doubles. Ids must be distinct and non-zero (0 means "slot free").
        fire(`/${surface}/blobs/blob${slot}/id`, 'i', slot + 1);
        fire(`/${surface}/blobs/blob${slot}/tx`, 'f', tx);
        fire(`/${surface}/blobs/blob${slot}/ty`, 'f', ty);
        fire(`/${surface}/blobs/blob${slot}/u`, 'f', tx / SCALE_X + 0.5);
        fire(`/${surface}/blobs/blob${slot}/v`, 'f', ty / SCALE_Y + 0.5);
        slot++;
      }
    }
  }
}

console.log(PAIRS
  ? `emitting ${N} people = ${N * 2} blobs/surface (SOL+MUR, ${HALF_GAP_M * 2}m apart) at ${FPS}fps -> ${HOST}:${PORT}  (Ctrl+C to stop)`
  : `emitting ${N} blobs/surface (SOL+MUR) at ${FPS}fps -> ${HOST}:${PORT}  (Ctrl+C to stop)`);
const id = setInterval(frame, 1000 / FPS);
process.on('SIGINT', () => { clearInterval(id); sock.close(); process.exit(0); });
