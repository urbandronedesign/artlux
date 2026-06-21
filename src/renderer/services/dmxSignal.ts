
// A lightweight event bus to decouple the Render Loop from React Components.
export interface DmxDestination {
    ip: string;
    broadcast: boolean;
    sparse: boolean;
    universes: Record<number, number[]>;
}

type DmxData = {
    pixels: Uint8Array; // Raw RGBW linear buffer (canonical, for the monitor/3D)
    destinations: Record<string, DmxDestination>; // per-target routing for output
};

type Listener = (data: DmxData) => void;

const listeners = new Set<Listener>();

export const dmxSignal = {
    publish: (pixels: Uint8Array, destinations: Record<string, DmxDestination>) => {
        const payload = { pixels, destinations };
        listeners.forEach(cb => cb(payload));
    },
    subscribe: (cb: Listener) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }
};
