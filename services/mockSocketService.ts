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

// Helper to construct an ArtNet III DMX Packet (OpOutput)
const buildArtNetPacket = (universe: number, dmxData: number[]): number[] => {
    const header = [65, 114, 116, 45, 78, 101, 116, 0]; 
    const opCode = [0x00, 0x50]; 
    const protoVer = [0x00, 0x0e];
    const seq = [sequence];
    const physical = [0];
    const uni = [universe & 0xFF, (universe >> 8) & 0xFF];
    const lenVal = dmxData.length;
    const len = [(lenVal >> 8) & 0xFF, lenVal & 0xFF];
    
    return [ ...header, ...opCode, ...protoVer, ...seq, ...physical, ...uni, ...len, ...dmxData ];
};

export const connectToBridge = (url: string) => {
    // If we are already trying to connect or connected to this URL, skip
    if (socket && activeUrl === url) {
        if (socket.readyState === WebSocket.OPEN) return;
        if (socket.readyState === WebSocket.CONNECTING) return;
    }

    disconnectBridge(false); // Clean up existing socket but don't clear intent if just retrying

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
            // Attempt reconnect if we still have an activeUrl (intent to connect)
            if (activeUrl && !reconnectTimer) {
                reconnectTimer = window.setTimeout(() => {
                    reconnectTimer = null;
                    connectToBridge(activeUrl!);
                }, 3000);
            }
        };

        socket.onerror = (e) => {
            console.warn("ArtNet Bridge Error", e);
            // Error usually precedes close, so close logic handles retry
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
        // Prevent reconnect loop if manually disconnecting
        const s = socket;
        socket = null; // Detach first
        s.onclose = null; // Remove listener to prevent trigger
        s.close();
    }
    notifyListeners(false);
    if (fully) activeUrl = null;
};

export const sendDmxData = (fixtures: Fixture[], settings: AppSettings) => {
    if (!settings.useWsBridge || !socket || socket.readyState !== WebSocket.OPEN) return;

    const now = performance.now();
    // Cap at ~40fps (25ms)
    if (now - lastSendTime < 25) return;
    lastSendTime = now;

    // 1. Map Fixtures to Universe Buffers
    const universeData: Record<number, number[]> = {};

    fixtures.forEach(fixture => {
        const globalStart = (fixture.universe * 512) + (fixture.startAddress - 1);
        fixture.colorData.forEach((color, i) => {
            const channels = [color.r, color.g, color.b, color.w];
            channels.forEach((val, offset) => {
                const absAddr = globalStart + (i * 4) + offset;
                const u = Math.floor(absAddr / 512);
                const ch = absAddr % 512;
                if (!universeData[u]) {
                    universeData[u] = new Array(512).fill(0);
                }
                universeData[u][ch] = val;
            });
        });
    });

    sequence = (sequence + 1) % 256;

    Object.entries(universeData).forEach(([uKey, data]) => {
        const uIndex = parseInt(uKey);
        const packet = buildArtNetPacket(uIndex, data);

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