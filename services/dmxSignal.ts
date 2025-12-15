
// A lightweight event bus to decouple the Render Loop from React Components
type DmxData = {
    pixels: Uint8Array; // Raw RGBW linear buffer
    universes: Record<number, number[]>; // ArtNet organized data
};

type Listener = (data: DmxData) => void;

const listeners = new Set<Listener>();

export const dmxSignal = {
    publish: (pixels: Uint8Array, universes: Record<number, number[]>) => {
        const payload = { pixels, universes };
        listeners.forEach(cb => cb(payload));
    },
    subscribe: (cb: Listener) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }
};
