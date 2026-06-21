import dgram from 'node:dgram';
import type { ArtNetDevice } from '../../../shared/protocol';

// Art-Net device discovery: broadcast an ArtPoll (OpCode 0x2000) on UDP 6454 and
// collect ArtPollReply (0x2100) packets from nodes for a short window. Coexists
// with input.ts on 6454 via SO_REUSEADDR. Control-plane only (not the hot path).

const ARTNET_PORT = 6454;
const ARTNET_ID = Buffer.from('Art-Net\0', 'ascii'); // 8 bytes

function buildArtPoll(): Buffer {
  const b = Buffer.alloc(14);
  ARTNET_ID.copy(b, 0);
  b[8] = 0x00; b[9] = 0x20;   // OpPoll 0x2000 (little-endian)
  b[10] = 0; b[11] = 14;      // ProtVer Hi/Lo = 14
  b[12] = 0x00;               // TalkToMe
  b[13] = 0x00;               // Priority
  return b;
}

function asciiZ(buf: Buffer, start: number, max: number): string {
  let end = start;
  const limit = Math.min(start + max, buf.length);
  while (end < limit && buf[end] !== 0) end++;
  return buf.toString('ascii', start, end).trim();
}

// Parse an ArtPollReply per the Art-Net spec field offsets (matches the
// artnet_protocol crate's PollReply layout: address @10, short_name @26[18],
// long_name @44[64], mac @201[6]).
function parsePollReply(msg: Buffer, srcIp: string): ArtNetDevice | null {
  if (msg.length < 108) return null;
  if (msg.toString('ascii', 0, 7) !== 'Art-Net') return null;
  const op = msg[8] | (msg[9] << 8);
  if (op !== 0x2100) return null;

  const ipField = `${msg[10]}.${msg[11]}.${msg[12]}.${msg[13]}`;
  const ip = ipField === '0.0.0.0' ? srcIp : ipField;
  const shortName = asciiZ(msg, 26, 18);
  const longName = asciiZ(msg, 44, 64);
  const oem = (msg[20] << 8) | msg[21];

  let mac: string | undefined;
  if (msg.length >= 207) {
    mac = Array.from(msg.subarray(201, 207)).map((x) => x.toString(16).padStart(2, '0')).join(':');
    if (mac === '00:00:00:00:00:00') mac = undefined;
  }

  return { ip, shortName, longName, mac, oem };
}

// Broadcast an ArtPoll and resolve with the unique nodes that replied within the
// window (de-duplicated by IP). Never rejects — returns [] on socket failure.
export function discover(durationMs = 3000): Promise<ArtNetDevice[]> {
  return new Promise((resolve) => {
    const devices = new Map<string, ArtNetDevice>();
    let sock: dgram.Socket | null = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock?.close(); } catch { /* ignore */ }
      sock = null;
      resolve(Array.from(devices.values()));
    };

    sock.on('error', (e) => { console.error('[discovery] socket error', e); finish(); });
    sock.on('message', (msg, rinfo) => {
      const d = parsePollReply(msg, rinfo.address);
      if (d) devices.set(d.ip, d);
    });

    sock.bind(ARTNET_PORT, () => {
      try { sock?.setBroadcast(true); } catch { /* ignore */ }
      try {
        sock?.send(buildArtPoll(), ARTNET_PORT, '255.255.255.255');
      } catch (e) {
        console.error('[discovery] send failed', e);
      }
    });

    timer = setTimeout(finish, durationMs);
  });
}
