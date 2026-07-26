import type { UniverseTarget } from './protocol';

// Compact binary wire format for one output frame, shared by the renderer
// (encode) and the main process / Rust engine (decode). Little-endian.
//
// Layout:
//   u32 targetCount
//   per target:
//     u8  protocol (0=artnet, 1=sacn, 2=enttec USB — the `ip` field carries the COM port path)
//     u8  broadcast
//     u8  sparse
//     u8  priority
//     u16 port
//     u16 ipLen, ipLen bytes (utf8)
//     u16 universeCount
//     per universe:
//       u16 universe
//       u16 dataLen, dataLen bytes

export function encodeFrame(targets: UniverseTarget[]): ArrayBuffer {
  const enc = new TextEncoder();
  // First pass: compute size + cache encoded ip/universe entries.
  let size = 4;
  const ipBytes: Uint8Array[] = [];
  const uniLists: { u: number; arr: number[] }[][] = [];
  for (const t of targets) {
    const ip = enc.encode(t.ip);
    ipBytes.push(ip);
    size += 1 + 1 + 1 + 1 + 2 + 2 + ip.length + 2;
    const list: { u: number; arr: number[] }[] = [];
    for (const k in t.universes) {
      const arr = t.universes[k];
      list.push({ u: Number(k), arr });
      size += 2 + 2 + Math.min(arr.length, 512);
    }
    uniLists.push(list);
  }

  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let o = 0;
  dv.setUint32(o, targets.length, true); o += 4;
  targets.forEach((t, ti) => {
    bytes[o++] = t.protocol === 'sacn' ? 1 : t.protocol === 'enttec' ? 2 : 0;
    bytes[o++] = t.broadcast ? 1 : 0;
    bytes[o++] = t.sparse ? 1 : 0;
    bytes[o++] = Math.max(0, Math.min(255, t.priority ?? 100));
    dv.setUint16(o, t.port, true); o += 2;
    const ip = ipBytes[ti];
    dv.setUint16(o, ip.length, true); o += 2;
    bytes.set(ip, o); o += ip.length;
    const list = uniLists[ti];
    dv.setUint16(o, list.length, true); o += 2;
    for (const { u, arr } of list) {
      const len = Math.min(arr.length, 512);
      dv.setUint16(o, u, true); o += 2;
      dv.setUint16(o, len, true); o += 2;
      for (let i = 0; i < len; i++) bytes[o++] = arr[i] & 0xff;
    }
  });
  return buf;
}

export function decodeFrame(buf: ArrayBuffer): UniverseTarget[] {
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const dec = new TextDecoder();
  let o = 0;
  const count = dv.getUint32(o, true); o += 4;
  const targets: UniverseTarget[] = [];
  for (let t = 0; t < count; t++) {
    const p = bytes[o++];
    const protocol = p === 1 ? 'sacn' : p === 2 ? 'enttec' : 'artnet';
    const broadcast = bytes[o++] === 1;
    const sparse = bytes[o++] === 1;
    const priority = bytes[o++];
    const port = dv.getUint16(o, true); o += 2;
    const ipLen = dv.getUint16(o, true); o += 2;
    const ip = dec.decode(bytes.subarray(o, o + ipLen)); o += ipLen;
    const uniCount = dv.getUint16(o, true); o += 2;
    const universes: Record<number, number[]> = {};
    for (let u = 0; u < uniCount; u++) {
      const universe = dv.getUint16(o, true); o += 2;
      const dlen = dv.getUint16(o, true); o += 2;
      universes[universe] = Array.from(bytes.subarray(o, o + dlen)); o += dlen;
    }
    targets.push({ ip, port, protocol, broadcast, sparse, priority, universes });
  }
  return targets;
}
