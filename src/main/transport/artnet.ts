import dgram from 'node:dgram';
import type { OutputConfig, ArtNetFramePayload } from '../../../shared/protocol';

// Native Art-Net (OpOutput) transmitter with per-fixture routing: each frame
// carries one or more destinations (controller IP + its universes); we fan out
// a packet per universe to each destination, with optional changed-only
// (sparse) skipping. Raw UDP from the main process.

// "Art-Net\0" + OpOutput (0x5000, little-endian) + ProtoVer (14, big-endian)
const ARTNET_HEADER = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14];

let socket: dgram.Socket | null = null;
let ready = false;
let currentBroadcast = false;
let sequence = 0;
let syncEnabled = false;

// ArtSync (OpSync 0x5200): 14-byte header (ID + opcode + ProtVer + 2 aux). Constant.
const ARTSYNC = Buffer.alloc(14);
for (let i = 0; i < 12; i++) ARTSYNC[i] = ARTNET_HEADER[i];
ARTSYNC[9] = 0x52; // OpSync high byte (override OpOutput 0x50)

// Last bytes sent per `${ip}:${universe}` for changed-only (sparse) skipping.
const lastSent = new Map<string, Uint8Array>();

// Reusable packet buffer (18-byte header + up to 512 data bytes) to avoid GC.
const packet = Buffer.alloc(530);
for (let i = 0; i < 12; i++) packet[i] = ARTNET_HEADER[i];

export function configure(cfg: OutputConfig): void {
    syncEnabled = !!cfg.sync;
    if (!socket) {
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', (err) => console.error('[artnet] socket error', err));
        socket.bind(() => {
            ready = true;
            try {
                socket?.setBroadcast(!!cfg.broadcast);
                currentBroadcast = !!cfg.broadcast;
            } catch (err) {
                console.warn('[artnet] setBroadcast failed', err);
            }
        });
    }
}

export function isReady(): boolean {
    return ready;
}

export function sendFrame(payload: ArtNetFramePayload): void {
    if (!socket || !ready || !payload.targets) return;

    // Unique destinations this frame, for a trailing ArtSync.
    const syncDests = new Map<string, { ip: string; port: number; broadcast: boolean }>();

    for (const target of payload.targets) {
        if (target.broadcast !== currentBroadcast) {
            try { socket.setBroadcast(target.broadcast); currentBroadcast = target.broadcast; } catch { /* ignore */ }
        }
        if (syncEnabled) syncDests.set(`${target.ip}:${target.port}`, { ip: target.ip, port: target.port, broadcast: target.broadcast });

        for (const key in target.universes) {
            const universe = Number(key);
            const data = target.universes[key];
            const len = Math.min(data.length, 512);
            const mapKey = `${target.ip}:${universe}`;

            // Changed-only skip (only when this destination opted into sparse).
            const prev = lastSent.get(mapKey);
            let changed = !prev || prev.length !== len;
            if (!changed && prev) {
                for (let i = 0; i < len; i++) { if (prev[i] !== (data[i] & 0xff)) { changed = true; break; } }
            }
            if (target.sparse && !changed) continue;

            sequence = (sequence + 1) % 256;
            if (sequence === 0) sequence = 1; // Art-Net: 0 disables sequence tracking

            packet[12] = sequence;                 // Sequence
            packet[13] = 0;                        // Physical
            packet[14] = universe & 0xff;          // Universe low
            packet[15] = (universe >> 8) & 0xff;   // Universe high (Net/SubNet)
            packet[16] = (len >> 8) & 0xff;        // Length high
            packet[17] = len & 0xff;               // Length low

            const snap = new Uint8Array(len);
            for (let i = 0; i < len; i++) { const v = data[i] & 0xff; packet[18 + i] = v; snap[i] = v; }
            lastSent.set(mapKey, snap);

            // dgram.send is async and must not see a mutated buffer; copy per packet.
            const out = Buffer.from(packet.subarray(0, 18 + len));
            socket.send(out, target.port, target.ip, (err) => {
                if (err) console.error('[artnet] send error', err);
            });
        }
    }

    // After all ArtDmx packets, send an ArtSync per destination so nodes latch
    // and output simultaneously (tear-free multi-universe).
    if (syncEnabled && syncDests.size) {
        for (const d of syncDests.values()) {
            if (d.broadcast !== currentBroadcast) {
                try { socket.setBroadcast(d.broadcast); currentBroadcast = d.broadcast; } catch { /* ignore */ }
            }
            socket.send(ARTSYNC, d.port, d.ip, (err) => {
                if (err) console.error('[artnet] sync send error', err);
            });
        }
    }
}

export function close(): void {
    if (socket) {
        socket.close();
        socket = null;
    }
    ready = false;
    lastSent.clear();
}
