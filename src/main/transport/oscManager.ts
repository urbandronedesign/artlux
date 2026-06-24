import dgram from 'node:dgram';
import type { OscMessage } from '../../../shared/protocol';

// OSC receiver/sender for the main process (the sandboxed renderer can't open a UDP socket).
// ArtLux is an OSC receiver in the installation: the 61fps tracking server emits LiDAR blob
// data + external control over OSC to port 10000. Mirrors the transport/*Manager.ts modules
// (artnet/input also use dgram) and degrades gracefully — a bind failure (port in use) logs
// and disables OSC rather than crashing the app.
//
// Self-contained OSC 1.0 codec (no dependency): the project's electron-vite config bundles
// main-process deps, and the `osc` npm package's optional serialport/ws requires would risk
// that bundle. The wire format is trivial, so we decode/encode it here.

// ---- Decode ------------------------------------------------------------------

// Read a 4-byte-aligned, null-terminated OSC string starting at `pos`. Returns [string, next].
function readString(buf: Buffer, pos: number): [string, number] {
  let end = pos;
  while (end < buf.length && buf[end] !== 0) end++;
  const str = buf.toString('utf8', pos, end);
  // Advance past the null and round up to the next 4-byte boundary.
  const next = pos + (Math.floor((end - pos) / 4) + 1) * 4;
  return [str, next];
}

// Decode one OSC message (address + typetags + args). Returns null on malformed input.
function decodeMessage(buf: Buffer): OscMessage | null {
  try {
    const [address, afterAddr] = readString(buf, 0);
    if (!address.startsWith('/')) return null;
    if (afterAddr >= buf.length) return { address, args: [] }; // address-only (no typetags)
    const [tags, afterTags] = readString(buf, afterAddr);
    if (!tags.startsWith(',')) return { address, args: [] };
    const args: (number | string)[] = [];
    let pos = afterTags;
    for (let i = 1; i < tags.length; i++) {
      switch (tags[i]) {
        case 'i': args.push(buf.readInt32BE(pos)); pos += 4; break;
        case 'f': args.push(buf.readFloatBE(pos)); pos += 4; break;
        case 'd': args.push(buf.readDoubleBE(pos)); pos += 8; break;
        case 's':
        case 'S': { const [s, n] = readString(buf, pos); args.push(s); pos = n; break; }
        case 'b': { const len = buf.readInt32BE(pos); pos += 4 + Math.ceil(len / 4) * 4; break; } // blob: skip
        case 'T': args.push(1); break;
        case 'F': args.push(0); break;
        case 'I': args.push(Infinity); break;
        case 'N': args.push(0); break;
        default: break; // unknown tag — stop consuming args we can't size
      }
    }
    return { address, args };
  } catch {
    return null;
  }
}

// Decode a UDP packet into 1+ messages. Handles an OSC bundle (#bundle\0 + timetag + sized
// elements, possibly nested) by flattening it to the messages it contains.
function decodePacket(buf: Buffer, out: OscMessage[]): void {
  if (buf.length >= 8 && buf.toString('ascii', 0, 8) === '#bundle\0') {
    let pos = 16; // skip "#bundle\0" (8) + timetag (8)
    while (pos + 4 <= buf.length) {
      const size = buf.readInt32BE(pos);
      pos += 4;
      if (size <= 0 || pos + size > buf.length) break;
      decodePacket(buf.subarray(pos, pos + size), out);
      pos += size;
    }
    return;
  }
  const msg = decodeMessage(buf);
  if (msg) out.push(msg);
}

// ---- Encode (send scaffold) --------------------------------------------------

function padString(str: string): Buffer {
  const raw = Buffer.from(str, 'utf8');
  const len = Math.floor(raw.length / 4 + 1) * 4; // null-terminate + 4-byte align
  const b = Buffer.alloc(len);
  raw.copy(b);
  return b;
}

function encodeMessage(address: string, args: (number | string)[]): Buffer {
  let tags = ',';
  const argBufs: Buffer[] = [];
  for (const a of args) {
    if (typeof a === 'string') { tags += 's'; argBufs.push(padString(a)); }
    else if (Number.isInteger(a)) { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a | 0); argBufs.push(b); }
    else { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); argBufs.push(b); }
  }
  return Buffer.concat([padString(address), padString(tags), ...argBufs]);
}

// ---- Socket lifecycle --------------------------------------------------------

let socket: dgram.Socket | null = null;
let sendSocket: dgram.Socket | null = null;

// Bind the listener on `port` and forward each packet's decoded messages to `onMessages`.
// Re-binds if already listening on a different port. No-throw on failure.
export function start(port: number, onMessages: (msgs: OscMessage[]) => void): void {
  stop();
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (data) => {
    const msgs: OscMessage[] = [];
    decodePacket(data, msgs);
    if (msgs.length) onMessages(msgs);
  });
  s.on('error', (err) => {
    console.error('[osc] socket error', err);
    try { s.close(); } catch { /* */ }
    if (socket === s) socket = null;
  });
  try {
    s.bind(port, () => console.log(`[osc] listening on udp/${port}`));
    socket = s;
  } catch (e) {
    console.error('[osc] bind failed', e);
  }
}

export function stop(): void {
  if (socket) { try { socket.close(); } catch { /* */ } socket = null; }
}

// Send scaffold (receive-first): fire-and-forget one OSC message to host:port.
export function send(host: string, port: number, address: string, args: (number | string)[]): void {
  if (!sendSocket) sendSocket = dgram.createSocket('udp4');
  const buf = encodeMessage(address, args);
  sendSocket.send(buf, port, host, (err) => { if (err) console.error('[osc] send failed', err); });
}
