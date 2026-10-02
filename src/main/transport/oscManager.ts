import dgram from 'node:dgram';
import os from 'node:os';
import type { OscMessage, OscOutPacket, OscSendStatus, OscTypedArg } from '../../../shared/protocol';

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

// Typed encode for the timeline OSC tracks: the TRACK decides the tag, never the number's shape (see
// OscTypedArg for why guessing breaks a float track that lands on a whole value). 'T'/'F' carry no
// payload — the type tag is the value, which is what a receiver's `isBoolean()` reads.
function encodeTyped(address: string, args: OscTypedArg[]): Buffer {
  let tags = ',';
  const argBufs: Buffer[] = [];
  for (const a of args) {
    switch (a.t) {
      case 'i': { tags += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(Math.max(-2147483648, Math.min(2147483647, Math.round(a.v)))); argBufs.push(b); break; }
      case 'f': { tags += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a.v); argBufs.push(b); break; }
      case 'T': tags += 'T'; break;
      case 'F': tags += 'F'; break;
      case 's': tags += 's'; argBufs.push(padString(a.v)); break;
    }
  }
  return Buffer.concat([padString(address), padString(tags), ...argBufs]);
}

// ---- Socket lifecycle --------------------------------------------------------

let socket: dgram.Socket | null = null;
let sendSocket: dgram.Socket | null = null;

// Bind the listener on `port` and forward each packet's decoded messages to `onMessages`.
// `address` binds to one local NIC (this machine's IP); empty/undefined = all interfaces.
// Re-binds on every (re)configure. No-throw on failure — a bad bind surfaces as an 'error' event.
export function start(port: number, onMessages: (msgs: OscMessage[]) => void, address?: string): void {
  stop();
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (data) => {
    const msgs: OscMessage[] = [];
    decodePacket(data, msgs);
    if (msgs.length) onMessages(msgs);
  });
  s.on('error', (err) => {
    // EADDRNOTAVAIL here means the chosen bind address isn't on any local NIC.
    console.error('[osc] socket error', err);
    try { s.close(); } catch { /* */ }
    if (socket === s) socket = null;
  });
  const where = address ? `${address}:${port}` : `udp/${port}`;
  try {
    const onBound = () => console.log(`[osc] listening on ${where}`);
    if (address) s.bind(port, address, onBound); else s.bind(port, onBound);
    socket = s;
  } catch (e) {
    console.error('[osc] bind failed', e);
  }
}

// This machine's non-internal IPv4 addresses — for the bind-to-NIC picker in Preferences.
export function localAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export function stop(): void {
  if (socket) { try { socket.close(); } catch { /* */ } socket = null; }
}

// ONE send socket for everything that leaves this machine as OSC, bound to an ephemeral port on all
// interfaces so the OS routes each datagram out of the NIC whose subnet matches the destination — the
// direct-cable case (a PC at 192.168.10.168 on its Ethernet card, Arduinos at .177/.178) needs nothing
// more than that. BROADCAST IS ENABLED so a track can address `192.168.10.255` and reach every board on
// the segment at once; Node refuses a broadcast destination with EACCES unless this is set, and it can
// only be set once the socket is bound — hence the explicit bind. Sends issued while the bind is still
// in flight are queued by dgram, not dropped.
function getSendSocket(): dgram.Socket {
  if (sendSocket) return sendSocket;
  const s = dgram.createSocket('udp4');
  s.on('error', (err) => {
    console.error('[osc] send socket error', err);
    try { s.close(); } catch { /* */ }
    if (sendSocket === s) sendSocket = null;
  });
  s.bind(0, () => { try { s.setBroadcast(true); } catch (e) { console.warn('[osc] setBroadcast failed', e); } });
  sendSocket = s;
  return s;
}

// Send scaffold (receive-first): fire-and-forget one OSC message to host:port.
export function send(host: string, port: number, address: string, args: (number | string)[]): void {
  const buf = encodeMessage(address, args);
  getSendSocket().send(buf, port, host, (err) => { if (err) console.error('[osc] send failed', err); });
}

// ---- Timeline OSC tracks: batched, typed, and ACCOUNTED -------------------------------------------
// UDP gives no delivery receipt, so the most main can honestly report is what the OS did with each
// datagram: accepted (`sent`) or refused (`errors` + the code). A refusal is the useful half — an
// EHOSTUNREACH / ENETUNREACH means "no interface on this machine is on that board's subnet", which is
// the commonest first-day Arduino failure (the PC's Ethernet card was never given a static address).
// Accepted does NOT mean received: a board that is unplugged still counts as `sent`. The tutorial says so.
const status = new Map<string, OscSendStatus>();
const statusOf = (host: string, port: number): OscSendStatus => {
  const k = `${host}:${port}`;
  let st = status.get(k);
  if (!st) { st = { host, port, sent: 0, errors: 0 }; status.set(k, st); }
  return st;
};

export function sendBatch(packets: OscOutPacket[]): void {
  if (!Array.isArray(packets)) return;
  const s = getSendSocket();
  for (const p of packets) {
    if (!p || typeof p.address !== 'string' || !p.address.startsWith('/') || !Array.isArray(p.targets)) continue;
    let buf: Buffer;
    try { buf = encodeTyped(p.address, Array.isArray(p.args) ? p.args : []); } catch { continue; }
    for (const t of p.targets) {
      const port = Math.trunc(Number(t?.port));
      const host = typeof t?.host === 'string' ? t.host.trim() : '';
      if (!host || !(port > 0 && port < 65536)) continue;
      const st = statusOf(host, port);
      try {
        s.send(buf, port, host, (err) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code ?? err.message;
            // Log on the FIRST refusal and whenever the reason changes — not per datagram. A track ramping
            // at 30 Hz into an unplugged subnet would otherwise write thirty lines a second, forever.
            if (st.lastError !== code) console.warn(`[osc] send to ${host}:${port} failed: ${code}`);
            st.errors++;
            st.lastError = code;
          } else {
            st.sent++;
            st.lastSentMs = Date.now();
            if (st.lastError) { console.log(`[osc] send to ${host}:${port} recovered`); st.lastError = undefined; }
          }
        });
      } catch (e) {
        st.errors++;
        st.lastError = (e as NodeJS.ErrnoException).code ?? String(e);
      }
    }
  }
}

export function sendStatus(): OscSendStatus[] {
  return [...status.values()].map((st) => ({ ...st }));
}
