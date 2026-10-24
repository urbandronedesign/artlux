// A scripted visitor for the interactive-show template: walks the whole state graph with no LiDAR.
//
//   node visitor.cjs [host] [port] [--loop]        # default 127.0.0.1 10000, one walk (~55 s)
//
// Speaks the venue protocol ArtLux's LiDAR input listens for (OSC on udp:10000, `/SOL/blobs/blobN/…`,
// the same packets as scripts/lidar-emitter.cjs) — but instead of orbiting at random, ONE person
// follows a script through the three zones, so every transition fires in order and you can watch each
// one happen. Each step prints what the show should do next, which is the whole point: if the show
// does something else, the line on screen says what was expected.
//
// The walk (zones from make-project.cjs; u across the room, v away from the wall):
//   1. the room is empty                         → Attract
//   2. walk in through the Entrance              → Welcome          (Entrance · someone enters)
//   3. cross to the Left pad and stand on it     → Story A          (Left pad · occupied for 1.5 s)
//   4. leave the room                            → Attract, 6 s later (all three zones empty for 6 s)
//   5. walk in again                             → Welcome
//   6. cross to the Right pad and stand          → Story B          (Right pad · occupied for 1.5 s)
//   7. leave                                     → Attract, 6 s later
//
// ArtLux needs the LiDAR (OSC) input enabled on the port this sends to — Preferences ▸ OSC / Tracking.

const dgram = require('node:dgram');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const HOST = args[0] || '127.0.0.1';
const PORT = parseInt(args[1] || '10000', 10);
const LOOP = process.argv.includes('--loop');
const FPS = 61;
const SCALE_X = 5.825, SCALE_Y = 3.125; // the floor, metres — what the venue tracker reports

const sock = dgram.createSocket('udp4');
function padString(str) {
  const raw = Buffer.from(str, 'utf8');
  const b = Buffer.alloc((Math.floor(raw.length / 4) + 1) * 4); raw.copy(b); return b;
}
function send(address, type, value) {
  const arg = Buffer.alloc(4);
  if (type === 'i') arg.writeInt32BE(value | 0); else arg.writeFloatBE(value);
  sock.send(Buffer.concat([padString(address), padString(',' + type), arg]), PORT, HOST);
}

// Where things are, in tracker space (0..1). v = 1 is the wall, v = 0 the side people come in from.
const DOOR = [0.5, -0.08];    // just outside the floor: the visitor is not tracked yet
const ENTRANCE = [0.5, 0.17];
const LEFT = [0.19, 0.65];
const RIGHT = [0.81, 0.65];

// [seconds from start, position or null (not in the room), what the show should do now]
const SCRIPT = [
  [0, null, 'The room is empty — the show runs Attract.'],
  [4, DOOR, 'A visitor walks in…'],
  [6, ENTRANCE, '…and steps into the Entrance → Welcome.'],
  [9, ENTRANCE, 'They read the welcome and head for the left pad.'],
  [12, LEFT, 'On the Left pad. After 1.5 s standing there → Story A.'],
  [20, LEFT, 'They leave the room.'],
  [24, DOOR, 'Gone. Once all three zones have been empty for 6 s → Attract.'],
  [25, null, null],
  [34, DOOR, 'A second walk: in again…'],
  [36, ENTRANCE, '…into the Entrance → Welcome.'],
  [39, ENTRANCE, 'This time to the right pad.'],
  [42, RIGHT, 'On the Right pad. After 1.5 s → Story B.'],
  [50, RIGHT, 'They leave.'],
  [54, DOOR, 'Gone. 6 s of an empty room → Attract.'],
  [55, null, null],
  [64, null, LOOP ? 'Walk complete — again.' : 'Walk complete.'],
];
const END = SCRIPT[SCRIPT.length - 1][0];

// Linear walk between two consecutive script points that both have a position; absent otherwise.
function positionAt(t) {
  for (let i = 0; i < SCRIPT.length - 1; i++) {
    const [t0, p0] = SCRIPT[i], [t1, p1] = SCRIPT[i + 1];
    if (t < t0 || t >= t1) continue;
    if (!p0) return null;
    if (!p1) return p0;
    const k = (t - t0) / (t1 - t0);
    return [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k];
  }
  return null;
}

const t0 = Date.now();
let said = -1;
function frame() {
  let t = (Date.now() - t0) / 1000;
  if (t >= END) {
    if (!LOOP) { send('/SOL/blobs/blob0/id', 'i', 0); console.log(SCRIPT[SCRIPT.length - 1][2]); process.exit(0); }
  }
  if (LOOP) t %= END;
  // Narrate each step once, as it starts.
  const step = SCRIPT.findIndex((s, i) => t >= s[0] && (i === SCRIPT.length - 1 || t < SCRIPT[i + 1][0]));
  if (step !== said) { said = step; if (SCRIPT[step][2]) console.log(`${String(Math.floor(t)).padStart(3)} s  ${SCRIPT[step][2]}`); }

  send('/SOL/specs/Scalex', 'f', SCALE_X);
  send('/SOL/specs/Scaley', 'f', SCALE_Y);
  const p = positionAt(t);
  // Off the floor (v < 0) counts as not in the room: the slot is freed (id 0), like the tracker does.
  if (!p || p[1] < 0) { send('/SOL/blobs/blob0/id', 'i', 0); return; }
  const tx = (p[0] - 0.5) * SCALE_X, ty = (p[1] - 0.5) * SCALE_Y;
  send('/SOL/blobs/blob0/id', 'i', 1);
  send('/SOL/blobs/blob0/tx', 'f', tx);
  send('/SOL/blobs/blob0/ty', 'f', ty);
  send('/SOL/blobs/blob0/u', 'f', p[0]);
  send('/SOL/blobs/blob0/v', 'f', p[1]);
}

console.log(`visitor → ${HOST}:${PORT}${LOOP ? ' (looping)' : ''}  Ctrl+C to stop`);
const timer = setInterval(frame, 1000 / FPS);
process.on('SIGINT', () => { clearInterval(timer); send('/SOL/blobs/blob0/id', 'i', 0); setTimeout(() => process.exit(0), 50); });
