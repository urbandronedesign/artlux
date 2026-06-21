import dgram from 'node:dgram';
import type { OutputConfig, ArtNetFramePayload } from '../../../shared/protocol';

// Native sACN / E1.31 (ANSI E1.31-2018) data packets over UDP. Multicasts to
// 239.255.<uHi>.<uLo>:5568 (when broadcast=true) or unicasts to target.ip.

const PORT = 5568;
const SOURCE_NAME = 'ArtLux';
// Stable component identifier (CID) for this source.
const CID = Uint8Array.from([
  0xa1, 0x17, 0x10, 0x5e, 0x4c, 0x55, 0x42, 0x00, 0x9a, 0x2c, 0x10, 0x7f, 0x3b, 0xd0, 0xe1, 0x71,
]);
const ACN_ID = Uint8Array.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);

let socket: dgram.Socket | null = null;
let ready = false;

const sequence = new Map<string, number>();      // `${dest}:${universe}` -> seq
const lastSent = new Map<string, Uint8Array>();   // changed-only (sparse)

function buildPacket(universe: number, data: number[], len: number, seq: number, priority: number): Buffer {
  const total = 126 + len;
  const buf = Buffer.alloc(total);
  // --- Root Layer ---
  buf.writeUInt16BE(0x0010, 0);                 // Preamble size
  buf.writeUInt16BE(0x0000, 2);                 // Post-amble size
  ACN_ID.forEach((b, i) => (buf[4 + i] = b));   // ACN packet identifier (12)
  buf.writeUInt16BE(0x7000 | (total - 16), 16); // Root flags + length
  buf.writeUInt32BE(0x00000004, 18);            // Root vector = VECTOR_ROOT_E131_DATA
  CID.forEach((b, i) => (buf[22 + i] = b));     // CID (16)
  // --- Framing Layer ---
  buf.writeUInt16BE(0x7000 | (total - 38), 38); // Framing flags + length
  buf.writeUInt32BE(0x00000002, 40);            // Framing vector = VECTOR_E131_DATA_PACKET
  buf.write(SOURCE_NAME, 44, 63, 'utf8');       // Source name (64, null-padded)
  buf[108] = priority;                          // Priority
  buf.writeUInt16BE(0, 109);                    // Sync address
  buf[111] = seq & 0xff;                        // Sequence number
  buf[112] = 0;                                 // Options
  buf.writeUInt16BE(universe & 0xffff, 113);    // Universe
  // --- DMP Layer ---
  buf.writeUInt16BE(0x7000 | (total - 115), 115); // DMP flags + length
  buf[117] = 0x02;                              // DMP vector = SET_PROPERTY
  buf[118] = 0xa1;                              // Address type & data type
  buf.writeUInt16BE(0x0000, 119);              // First property address
  buf.writeUInt16BE(0x0001, 121);              // Address increment
  buf.writeUInt16BE(len + 1, 123);             // Property value count (start code + slots)
  buf[125] = 0x00;                              // DMX start code
  for (let i = 0; i < len; i++) buf[126 + i] = data[i] & 0xff;
  return buf;
}

export function configure(_cfg: OutputConfig): void {
  if (!socket) {
    socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (err) => console.error('[sacn] socket error', err));
    socket.bind(() => {
      ready = true;
      try { socket?.setMulticastTTL(16); } catch { /* ignore */ }
    });
  }
}

export function isReady(): boolean { return ready; }

export function sendFrame(payload: ArtNetFramePayload): void {
  if (!socket || !ready || !payload.targets) return;

  for (const target of payload.targets) {
    const priority = target.priority ?? 100;
    for (const key in target.universes) {
      const universe = Number(key);
      const data = target.universes[key];
      const len = Math.min(data.length, 512);
      const dest = target.broadcast
        ? `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`
        : target.ip;
      const mapKey = `${dest}:${universe}`;

      // Changed-only skip for sparse destinations.
      const prev = lastSent.get(mapKey);
      let changed = !prev || prev.length !== len;
      if (!changed && prev) {
        for (let i = 0; i < len; i++) { if (prev[i] !== (data[i] & 0xff)) { changed = true; break; } }
      }
      if (target.sparse && !changed) continue;

      const seq = ((sequence.get(mapKey) ?? 0) + 1) & 0xff;
      sequence.set(mapKey, seq);

      const snap = new Uint8Array(len);
      for (let i = 0; i < len; i++) snap[i] = data[i] & 0xff;
      lastSent.set(mapKey, snap);

      const pkt = buildPacket(universe, data, len, seq, priority);
      socket.send(pkt, PORT, dest, (err) => {
        if (err) console.error('[sacn] send error', err);
      });
    }
  }
}

export function close(): void {
  if (socket) { socket.close(); socket = null; }
  ready = false;
  sequence.clear();
  lastSent.clear();
}
