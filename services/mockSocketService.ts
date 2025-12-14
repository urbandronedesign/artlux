import { Fixture, AppSettings } from '../types';

let socket: WebSocket | null = null;
let activeUrl: string | null = null;
let lastSendTime = 0;
let sequence = 0;
let reconnectTimer: number | null = null;

// Status Management
type StatusListener = (isConnected: boolean) => void;
const listeners: Set<StatusListener> = new Set();
let isConnected = false;

const notifyListeners = (status: boolean) => {
    isConnected = status;
    listeners.forEach(l => l(status));
};

export const addStatusListener = (listener: StatusListener) => {
    listeners.add(listener);
    listener(isConnected); // Immediate callback with current state
    return () => {
        listeners.delete(listener);
    };
};

// Reusable buffers to reduce GC pressure
const ARTNET_HEADER = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14]; // Header + OpCode + ProtoVer
// Pre-allocate universe buffers map to avoid recreation
const universeDataCache: Record<number, number[]> = {};

// Helper to construct an ArtNet III DMX Packet (OpOutput) efficiently
const buildArtNetPacket = (universe: number, dmxData: number[]): number[] => {
    // Fixed size: Header(12) + Seq(1) + Phy(1) + Uni(2) + Len(2) + Data(512)
    // We construct a standard array because JSON.stringify needs to serialize it for the bridge.
    // We avoid spread operators (...) for large arrays to prevent stack overflow and excessive GC.
    
    const lenVal = dmxData.length;
    // Header is 18 bytes total before data
    const packet = new Array(18 + lenVal);
    
    // 0-11: Fixed Header
    for(let i=0; i<12; i++) packet[i] = ARTNET_HEADER[i];
    
    packet[12] = sequence; // Sequence
    packet[13] = 0;        // Physical
    packet[14] = universe & 0xFF;        // Uni Low
    packet[15] = (universe >> 8) & 0xFF; // Uni High
    packet[16] = (lenVal >> 8) & 0xFF;   // Len High
    packet[17] = lenVal & 0xFF;          // Len Low
    
    // Copy Data
    for(let i=0; i<lenVal; i++) {
        packet[18+i] = dmxData[i];
    }
    
    return packet;
};

export const connectToBridge = (url: string) => {
    if (socket && activeUrl === url) {
        if (socket.readyState === WebSocket.OPEN) return;
        if (socket.readyState === WebSocket.CONNECTING) return;
    }

    disconnectBridge(false); 

    try {
        console.log(`Connecting to ArtNet Bridge: ${url}`);
        socket = new WebSocket(url);
        activeUrl = url;

        socket.onopen = () => {
            console.log("ArtNet Bridge Connected");
            notifyListeners(true);
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
        };

        socket.onclose = () => {
            console.log("ArtNet Bridge Disconnected");
            notifyListeners(false);
            socket = null;
            if (activeUrl && !reconnectTimer) {
                reconnectTimer = window.setTimeout(() => {
                    reconnectTimer = null;
                    connectToBridge(activeUrl!);
                }, 3000);
            }
        };

        socket.onerror = (e) => {
            console.warn("ArtNet Bridge Error", e);
        };
    } catch (err) {
        console.error("Failed to create WebSocket", err);
        socket = null;
        notifyListeners(false);
    }
};

export const disconnectBridge = (fully: boolean = true) => {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (socket) {
        const s = socket;
        socket = null; 
        s.onclose = null; 
        s.close();
    }
    notifyListeners(false);
    if (fully) activeUrl = null;
};

export const sendDmxData = (fixtures: Fixture[], settings: AppSettings) => {
    if (!settings.useWsBridge || !socket || socket.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    // Cap at ~44fps (approx 22.7ms). Using 22ms as threshold.
    if (now - lastSendTime < 22) return;
    lastSendTime = now;

    // Reset cache for this frame
    // We don't delete keys, just reset values to 0 if needed, or overwrite.
    // However, to be safe and simple, we clear content but maybe we can optimize structure later.
    // For now, let's just create the clean 512 arrays only if missing, and zero them out.
    // Actually, iterating to zero out might be as expensive as new Array(512).fill(0).
    // Let's use a temporary map for the frame.
    const currentFrameData: Record<number, number[]> = {};

    fixtures.forEach(fixture => {
        const globalStart = (fixture.universe * 512) + (fixture.startAddress - 1);
        
        // Optimization: Use a simpler loop
        const count = fixture.ledCount;
        const colors = fixture.colorData;
        
        // Guard against mismatch
        if (!colors || colors.length !== count) return;

        for(let i=0; i<count; i++) {
            const color = colors[i];
            const baseAddr = globalStart + (i * 4);
            
            // Unroll loop for R,G,B,W (4 channels)
            // Channel 0 (R)
            let absAddr = baseAddr;
            let u = (absAddr / 512) | 0; // Fast floor
            let ch = absAddr % 512;
            if (!currentFrameData[u]) currentFrameData[u] = new Array(512).fill(0);
            currentFrameData[u][ch] = color.r;

            // Channel 1 (G)
            absAddr++;
            if (ch === 511) { u++; ch = 0; if (!currentFrameData[u]) currentFrameData[u] = new Array(512).fill(0); } else { ch++; }
            currentFrameData[u][ch] = color.g;

            // Channel 2 (B)
            absAddr++;
            if (ch === 511) { u++; ch = 0; if (!currentFrameData[u]) currentFrameData[u] = new Array(512).fill(0); } else { ch++; }
            currentFrameData[u][ch] = color.b;

            // Channel 3 (W)
            absAddr++;
            if (ch === 511) { u++; ch = 0; if (!currentFrameData[u]) currentFrameData[u] = new Array(512).fill(0); } else { ch++; }
            currentFrameData[u][ch] = color.w;
        }
    });

    sequence = (sequence + 1) % 256;

    for (const uKey in currentFrameData) {
        const uIndex = parseInt(uKey);
        const data = currentFrameData[uIndex];
        const packet = buildArtNetPacket(uIndex, data);

        try {
            socket.send(JSON.stringify({
                type: 'broadcast-artnet',
                host: settings.artNetIp,
                port: settings.artNetPort,
                data: packet
            }));
        } catch (e) {
            console.error("Socket Send Error", e);
        }
    }
};