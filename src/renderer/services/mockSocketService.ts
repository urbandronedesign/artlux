import { AppSettings } from '../types';
import { UniverseTarget } from '../../../shared/protocol';
import { encodeFrame } from '../../../shared/frameCodec';
import { sendFrame as sendFramePort } from '../engine/framePort';
import type { DmxDestination } from './dmxSignal';

// Thin renderer-side wrapper over the Electron native Art-Net transport
// (exposed as `window.artlux` by the preload). Packet construction + UDP send
// now live in the main process (src/main/transport/artnet.ts); this module just
// throttles, forwards universe data over IPC, and relays output status.

let lastSendTime = 0;

// Status management (kept API-compatible with the previous WebSocket bridge).
type StatusListener = (isConnected: boolean) => void;
const listeners: Set<StatusListener> = new Set();
let isConnected = false;
let statusUnsub: (() => void) | null = null;

const notify = (status: boolean) => {
    isConnected = status;
    listeners.forEach(l => l(status));
};

// Lazily bind to the main-process status channel once `window.artlux` is ready.
const ensureStatusBridge = () => {
    if (statusUnsub || typeof window === 'undefined' || !window.artlux) return;
    statusUnsub = window.artlux.onStatus(notify);
};

export const addStatusListener = (listener: StatusListener) => {
    listeners.add(listener);
    listener(isConnected);
    ensureStatusBridge();
    return () => {
        listeners.delete(listener);
    };
};

// Apply output settings to the native transport. Call whenever settings change.
export const configureOutput = (settings: AppSettings) => {
    ensureStatusBridge();
    if (!window.artlux) {
        notify(false);
        return;
    }
    if (settings.outputEnabled) {
        window.artlux.configureOutput({
            ip: settings.artNetIp,
            port: settings.artNetPort,
            broadcast: settings.broadcast,
            fps: settings.fps,
            keepAlive: settings.keepAlive,
            sync: settings.artNetSync,
        });
        // main emits STATUS=true once the socket is ready
    } else {
        notify(false);
    }
};

// Reused across frames so a throttled-away frame allocates nothing; the encoder copies out of it.
const targetScratch: UniverseTarget[] = [];

// Send one frame of routing destinations. Throttled to ~44 FPS. The throttle is checked BEFORE
// building the target list, so frames dropped by the cap (the render loop runs faster than 44 Hz)
// cost zero allocation. Destinations come straight from the Stage packing pool (universes by ref).
export const sendArtNetFrame = (destinations: Record<string, DmxDestination>, port: number) => {
    if (!window.artlux) return;

    const now = performance.now();
    if (now - lastSendTime < 22) return; // ~44 FPS cap — gate first, before any work
    lastSendTime = now;

    targetScratch.length = 0;
    for (const k in destinations) {
        const d = destinations[k];
        targetScratch.push({ ip: d.ip, port, protocol: d.protocol, broadcast: d.broadcast, sparse: d.sparse, priority: d.priority, universes: d.universes });
    }
    if (targetScratch.length === 0) return;

    // Prefer the direct MessagePort to main (engine/framePort). Same bytes as the IPC route — both are
    // encodeFrame's output — but it does not go through ipcRenderer, which is what lets the frame
    // engine keep sending once it lives in a worker and the main thread is no longer in the path.
    // Falls back to IPC whenever the port is absent, so a machine that never gets one behaves exactly
    // as it always did rather than going quietly dark.
    const encoded = encodeFrame(targetScratch);
    if (sendFramePort(encoded)) return;
    window.artlux.sendArtNet(encoded);
};
