import { AppSettings } from '../types';

let socket: WebSocket | null = null;
let activeUrl: string | null = null;
let lastSendTime = 0;
let sequence = 0;
let reconnectTimer: number | null = null;

// Reusable ArtNet Buffers
// ArtNet Header: "Art-Net" + 0x00 + OpOutput(0x5000) + ProtoVer(14)
const ARTNET_HEADER = [65, 114, 116, 45, 78, 101, 116, 0, 0, 80, 0, 14]; 

// Single reusable buffer for packet construction to avoid GC
// Max size: 18 header + 512 data = 530 bytes
const reusablePacket = new Array(530).fill(0);

// Helper to construct packet into reusable buffer
const fillPacketBuffer = (universe: number, dmxData: number[]): number[] => {
    // 0-11: Fixed Header
    for(let i=0; i<12; i++) reusablePacket[i] = ARTNET_HEADER[i];
    
    const lenVal = dmxData.length;
    
    reusablePacket[12] = sequence; // Sequence
    reusablePacket[13] = 0;        // Physical
    reusablePacket[14] = universe & 0xFF;        // Uni Low
    reusablePacket[15] = (universe >> 8) & 0xFF; // Uni High
    reusablePacket[16] = (lenVal >> 8) & 0xFF;   // Len High
    reusablePacket[17] = lenVal & 0xFF;          // Len Low
    
    // Copy Data
    for(let i=0; i<lenVal; i++) {
        reusablePacket[18+i] = dmxData[i];
    }
    
    // Trim length logically for the JSON (we slice it to creating a sized array, which is lighter than new Array(n))
    return reusablePacket.slice(0, 18 + lenVal);
};

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
    listener(isConnected); 
    return () => {
        listeners.delete(listener);
    };
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
            // Only reconnect if we weren't explicitly disconnected (activeUrl still set)
            if (activeUrl && !reconnectTimer) {
                reconnectTimer = window.setTimeout(() => {
                    reconnectTimer = null;
                    if (activeUrl) connectToBridge(activeUrl);
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

// New Method: Accepts a Map of Universe -> Array
// This avoids processing fixtures logic here, just raw DMX transport
export const sendArtNetFrame = (universeData: Record<number, number[]>, settings: AppSettings) => {
    if (!settings.useWsBridge || !socket || socket.readyState !== WebSocket.OPEN) return;

    // BACKPRESSURE CHECK: Prevent memory leak if bridge is slow
    // If we have more than 64KB buffered, skip frame to allow drain
    if (socket.bufferedAmount > 64 * 1024) {
        console.warn("Dropping frame: WebSocket buffer full");
        return;
    }

    const now = performance.now();
    if (now - lastSendTime < 22) return; // ~44 FPS Cap
    lastSendTime = now;

    sequence = (sequence + 1) % 256;

    for (const uKey in universeData) {
        const uIndex = parseInt(uKey);
        const data = universeData[uIndex];
        const packet = fillPacketBuffer(uIndex, data);

        try {
            // Using a JSON structure as per bridge requirement.
            // Packet is a standard Array of numbers [0..255]
            const msg = JSON.stringify({
                type: 'broadcast-artnet',
                host: settings.artNetIp,
                port: settings.artNetPort,
                data: packet
            });
            socket.send(msg);
        } catch (e) {
            console.error("Socket Send Error", e);
        }
    }
};