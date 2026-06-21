import dgram from 'node:dgram';
import type { InputConfig, InputFrame } from '../../../shared/protocol';

// Receives Art-Net (UDP 6454) and/or sACN E1.31 (UDP 5568, multicast 239.255.x.x)
// and forwards the latest per-universe data to the renderer, coalesced at ~30 Hz.

const ARTNET_PORT = 6454;
const SACN_PORT = 5568;

let artnetSock: dgram.Socket | null = null;
let sacnSock: dgram.Socket | null = null;
let flushTimer: NodeJS.Timeout | null = null;
let cb: ((frames: InputFrame[]) => void) | null = null;
const latest = new Map<string, InputFrame>(); // `${protocol}:${universe}` -> frame

function parseArtnet(msg: Buffer): { universe: number; data: number[] } | null {
  if (msg.length < 18) return null;
  if (msg.toString('ascii', 0, 7) !== 'Art-Net') return null;
  const opcode = msg[8] | (msg[9] << 8);
  if (opcode !== 0x5000) return null; // OpOutput
  const universe = msg[14] | (msg[15] << 8);
  const len = (msg[16] << 8) | msg[17];
  return { universe, data: Array.from(msg.subarray(18, 18 + Math.min(len, 512))) };
}

function parseSacn(msg: Buffer): { universe: number; data: number[] } | null {
  if (msg.length < 126) return null;
  if (msg.toString('ascii', 4, 13) !== 'ASC-E1.17') return null;
  const universe = msg.readUInt16BE(113);
  const propCount = msg.readUInt16BE(123);
  const len = Math.max(0, propCount - 1); // minus start code
  // DMX values start at byte 126 (after the 0x00 start code at 125)
  return { universe, data: Array.from(msg.subarray(126, 126 + Math.min(len, 512))) };
}

export function configureInput(cfg: InputConfig, callback: (frames: InputFrame[]) => void): void {
  cb = callback;
  stop();
  if (!cfg.enabled) return;

  const wantArt = cfg.protocol === 'artnet' || cfg.protocol === 'both';
  const wantSacn = cfg.protocol === 'sacn' || cfg.protocol === 'both';

  if (wantArt) {
    artnetSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    artnetSock.on('error', (e) => console.error('[input:artnet]', e));
    artnetSock.on('message', (m) => {
      const p = parseArtnet(m);
      if (p) latest.set(`artnet:${p.universe}`, { protocol: 'artnet', ...p });
    });
    artnetSock.bind(ARTNET_PORT);
  }

  if (wantSacn) {
    sacnSock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sacnSock.on('error', (e) => console.error('[input:sacn]', e));
    sacnSock.on('message', (m) => {
      const p = parseSacn(m);
      if (p) latest.set(`sacn:${p.universe}`, { protocol: 'sacn', ...p });
    });
    sacnSock.bind(SACN_PORT, () => {
      for (const u of (cfg.universes && cfg.universes.length ? cfg.universes : [0, 1, 2, 3])) {
        try { sacnSock?.addMembership(`239.255.${(u >> 8) & 0xff}.${u & 0xff}`); } catch { /* ignore */ }
      }
    });
  }

  flushTimer = setInterval(() => {
    if (latest.size && cb) cb(Array.from(latest.values()));
  }, 33);
}

export function stop(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (artnetSock) { try { artnetSock.close(); } catch { /* */ } artnetSock = null; }
  if (sacnSock) { try { sacnSock.close(); } catch { /* */ } sacnSock = null; }
  latest.clear();
}
