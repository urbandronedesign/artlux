// Synthetic Augmenta emitter — speaks the Augmenta OSC v2 protocol to a UDP port. Lets you exercise
// the Augmenta Monitor (View ▸ Augmenta Monitor), the AUGMENTA content source, the 3D field viz, and
// the projector self-render without the real Augmenta box present.
//
//   node scripts/augmenta-emitter.cjs [host] [port] [nObjects]   # default 127.0.0.1 12000 3
//
// Point it at the app's OSC listen port (Preferences ▸ OSC / Tracking). Each object orbits the field
// so motion / smoothing / heading / trails are visible. Ctrl+C to stop.
//
// Message layout (Augmenta OSC v2 person/object):
//   /au/scene         [frame(i), objectCount(i), sceneWidth(f,m), sceneHeight(f,m)]
//   /au/personUpdated [pid(i), oid(i), age(i), cx(f), cy(f), vx(f), vy(f), depth(f),
//                      bx(f), by(f), bw(f), bh(f), hx(f), hy(f), hz(f)]
// centroid is normalized [0..1] top-left (the app flips cy → bottom-left internally).
const dgram = require('node:dgram');

const HOST = process.argv[2] || '127.0.0.1';
const PORT = parseInt(process.argv[3] || '12000', 10);
const N = parseInt(process.argv[4] || '3', 10);
const FPS = 30;

const SCENE_W = 6.0, SCENE_H = 4.0; // field size, metres

const sock = dgram.createSocket('udp4');

function padString(str) {
  const raw = Buffer.from(str, 'utf8');
  const len = (Math.floor(raw.length / 4) + 1) * 4; // null-terminate + 4-byte align
  const b = Buffer.alloc(len); raw.copy(b); return b;
}
// A multi-arg OSC message. `args` is an array of ['i'|'f', value].
function osc(address, args) {
  let tags = ',';
  const bufs = [];
  for (const [type, value] of args) {
    tags += type;
    const a = Buffer.alloc(4);
    if (type === 'i') a.writeInt32BE(value | 0); else a.writeFloatBE(value);
    bufs.push(a);
  }
  return Buffer.concat([padString(address), padString(tags), ...bufs]);
}
function fire(address, args) { sock.send(osc(address, args), PORT, HOST); }

let frame = 0;
let t = 0;
function tick() {
  t += 1 / FPS;
  frame++;
  fire('/au/scene', [['i', frame], ['i', N], ['f', SCENE_W], ['f', SCENE_H]]);
  for (let i = 0; i < N; i++) {
    const phase = t * (0.4 + i * 0.2) + i * 2.1;
    const cx = 0.5 + 0.4 * Math.cos(phase);
    const cy = 0.5 + 0.4 * Math.sin(phase * 1.3);
    const vx = -0.4 * 0.4 * Math.sin(phase);       // d(cx)/dt scaled
    const vy = 0.4 * 1.3 * 0.4 * Math.cos(phase * 1.3);
    fire('/au/personUpdated', [
      ['i', i + 1],   // pid
      ['i', i],       // oid
      ['i', frame],   // age (frames)
      ['f', cx], ['f', cy],
      ['f', vx], ['f', vy],
      ['f', 2.5],                       // depth (m)
      ['f', cx - 0.05], ['f', cy - 0.1], // boundingRect x,y
      ['f', 0.1], ['f', 0.2],            // boundingRect w,h
      ['f', cx], ['f', cy], ['f', 1.8],  // highest x,y,z
    ]);
  }
}

console.log(`emitting ${N} Augmenta objects at ${FPS}fps -> ${HOST}:${PORT}  (field ${SCENE_W}x${SCENE_H} m, Ctrl+C to stop)`);
const id = setInterval(tick, 1000 / FPS);
process.on('SIGINT', () => { clearInterval(id); sock.close(); process.exit(0); });
