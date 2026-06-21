import dgram from 'node:dgram';
import type { OutputConfig, ArtNetFramePayload } from '../../../shared/protocol';

// Native Art-Net (OpOutput) transmitter. Ported from the renderer's previous
// WebSocket-bridge packet builder, now sending raw UDP from the main process.

// "Art-Net\0" + OpOutput (0x5000, little-endian) + ProtoVer (14, big-endian)
const ARTNET_HEADER = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14];

let socket: dgram.Socket | null = null;
let target: OutputConfig | null = null;
let sequence = 0;

// Reusable packet buffer (18-byte header + up to 512 data bytes) to avoid GC.
const packet = Buffer.alloc(530);
for (let i = 0; i < 12; i++) packet[i] = ARTNET_HEADER[i];

export function configure(cfg: OutputConfig): void {
    target = cfg;
    if (!socket) {
        // Create + bind the sender socket exactly once; broadcast is toggled
        // after bind (and can be re-toggled on later configure calls).
        socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
        socket.on('error', (err) => console.error('[artnet] socket error', err));
        socket.bind(() => {
            try {
                socket?.setBroadcast(!!cfg.broadcast);
            } catch (err) {
                console.warn('[artnet] setBroadcast failed', err);
            }
        });
    } else {
        try {
            socket.setBroadcast(!!cfg.broadcast);
        } catch (err) {
            console.warn('[artnet] setBroadcast failed', err);
        }
    }
}

export function isReady(): boolean {
    return !!socket && !!target;
}

export function sendFrame(payload: ArtNetFramePayload): void {
    if (!socket || !target) return;
    const { universes } = payload;

    sequence = (sequence + 1) % 256;
    if (sequence === 0) sequence = 1; // Art-Net: 0 means "disable sequence"

    for (const key in universes) {
        const universe = Number(key);
        const data = universes[key];
        const len = Math.min(data.length, 512);

        packet[12] = sequence;                 // Sequence
        packet[13] = 0;                        // Physical
        packet[14] = universe & 0xff;          // Universe low
        packet[15] = (universe >> 8) & 0xff;   // Universe high (Net/SubNet)
        packet[16] = (len >> 8) & 0xff;        // Length high
        packet[17] = len & 0xff;               // Length low
        for (let i = 0; i < len; i++) packet[18 + i] = data[i] & 0xff;

        const out = packet.subarray(0, 18 + len);
        socket.send(out, target.port, target.ip, (err) => {
            if (err) console.error('[artnet] send error', err);
        });
    }
}

export function close(): void {
    if (socket) {
        socket.close();
        socket = null;
    }
    target = null;
}
