import { Fixture, AppSettings } from '../types';

let socket: WebSocket | null = null;
let activeUrl: string | null = null;
let lastSendTime = 0;
let sequence = 0;

// Helper to construct an ArtNet III DMX Packet (OpOutput)
// See Art-Net Specification for header details
const buildArtNetPacket = (universe: number, dmxData: number[]): number[] => {
    // 1. Header: "Art-Net" + 0x00 (8 bytes)
    const header = [65, 114, 116, 45, 78, 101, 116, 0]; 
    
    // 2. OpCode: OpOutput (0x5000). Transmitted Low-Byte first -> 0x00, 0x50
    const opCode = [0x00, 0x50]; 
    
    // 3. Protocol Version: 14 (0x0E). High-Byte first -> 0x00, 0x0E
    const protoVer = [0x00, 0x0e];
    
    // 4. Sequence: 0-255, increments every packet
    const seq = [sequence];
    
    // 5. Physical: 0 (Information only)
    const physical = [0];
    
    // 6. Universe: 15-bit address. Low-Byte first.
    // (Net is high 7 bits, SubNet is next 4, Universe is low 4).
    // We treat the 'universe' number as the flat address for simplicity.
    const uni = [universe & 0xFF, (universe >> 8) & 0xFF];
    
    // 7. Length: Data length (2 - 512). High-Byte first.
    const lenVal = dmxData.length;
    const len = [(lenVal >> 8) & 0xFF, lenVal & 0xFF];
    
    return [
        ...header,
        ...opCode,
        ...protoVer,
        ...seq,
        ...physical,
        ...uni,
        ...len,
        ...dmxData
    ];
};

export const connectToBridge = (url: string) => {
    if (socket && activeUrl === url && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    if (socket) {
        try { socket.close(); } catch (e) { /* ignore */ }
    }

    try {
        console.log(`Connecting to ArtNet Bridge: ${url}`);
        socket = new WebSocket(url);
        activeUrl = url;

        socket.onopen = () => console.log("ArtNet Bridge Connected");
        socket.onclose = () => console.log("ArtNet Bridge Disconnected");
        socket.onerror = (e) => console.warn("ArtNet Bridge Error", e);
    } catch (err) {
        console.error("Failed to create WebSocket", err);
        socket = null;
    }
};

export const disconnectBridge = () => {
    if (socket) {
        socket.close();
        socket = null;
        activeUrl = null;
    }
};

export const sendDmxData = (fixtures: Fixture[], settings: AppSettings) => {
    if (!settings.useWsBridge || !socket || socket.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    // Cap at ~40fps (25ms) to avoid network congestion
    if (now - lastSendTime < 25) return;
    lastSendTime = now;

    // 1. Map Fixtures to Universe Buffers
    const universeData: Record<number, number[]> = {};

    fixtures.forEach(fixture => {
        // Absolute starting address (0-indexed internally)
        const globalStart = (fixture.universe * 512) + (fixture.startAddress - 1);
        
        fixture.colorData.forEach((color, i) => {
            // R, G, B, W
            const channels = [color.r, color.g, color.b, color.w];
            
            channels.forEach((val, offset) => {
                const absAddr = globalStart + (i * 4) + offset;
                const u = Math.floor(absAddr / 512);
                const ch = absAddr % 512;

                if (!universeData[u]) {
                    // Initialize with zeros
                    universeData[u] = new Array(512).fill(0);
                }
                universeData[u][ch] = val;
            });
        });
    });

    // 2. Increment Sequence (once per frame, or per packet? Spec says per packet implies per universe update)
    // We increment once per batch for simplicity or per packet. ArtNet spec says unique sequence per IP/Universe.
    // A global rotator is usually fine for simple controllers.
    sequence = (sequence + 1) % 256;

    // 3. Construct and Send Packets
    Object.entries(universeData).forEach(([uKey, data]) => {
        const uIndex = parseInt(uKey);
        
        // Build valid ArtNet binary packet
        const packet = buildArtNetPacket(uIndex, data);

        // Send to Bridge
        // Protocol: { type: 'broadcast-artnet', host, port, data: number[] }
        try {
            socket?.send(JSON.stringify({
                type: 'broadcast-artnet',
                host: settings.artNetIp,
                port: settings.artNetPort,
                data: packet
            }));
        } catch (e) {
            console.error("Socket Send Error", e);
        }
    });
};