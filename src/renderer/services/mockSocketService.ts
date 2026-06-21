import { AppSettings } from '../types';
import { UniverseTarget } from '../../../shared/protocol';
import { encodeFrame } from '../../../shared/frameCodec';

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
        });
        // main emits STATUS=true once the socket is ready
    } else {
        notify(false);
    }
};

// Send one frame as a set of routing targets. Throttled to ~44 FPS.
export const sendArtNetFrame = (targets: UniverseTarget[]) => {
    if (!window.artlux || targets.length === 0) return;

    const now = performance.now();
    if (now - lastSendTime < 22) return; // ~44 FPS cap
    lastSendTime = now;

    window.artlux.sendArtNet(encodeFrame(targets));
};
