import { InputFrame } from '../../../shared/protocol';

// Receives incoming DMX universes from the main process and assembles them into a
// small canvas (one row per universe, RGB triples across) usable as a content
// source for the mapper — so incoming DMX drives fixtures like any other source.

const universes = new Map<number, Uint8Array>();
let unsub: (() => void) | null = null;
let canvas: HTMLCanvasElement | null = null;

export function startInput(): void {
  if (unsub || typeof window === 'undefined' || !window.artlux) return;
  unsub = window.artlux.onDmxInput((frames: InputFrame[]) => {
    for (const f of frames) {
      const arr = universes.get(f.universe) ?? new Uint8Array(512);
      arr.set(f.data.slice(0, 512));
      universes.set(f.universe, arr);
    }
  });
}

export function stopInput(): void {
  unsub?.();
  unsub = null;
  universes.clear();
}

const PX_PER_UNIVERSE = 170; // 512 channels / 3 (RGB)

// Returns a canvas with current input (row = universe), or null if no data yet.
export function getInputCanvas(): HTMLCanvasElement | null {
  if (universes.size === 0) return null;
  const keys = Array.from(universes.keys()).sort((a, b) => a - b);
  if (!canvas) canvas = document.createElement('canvas');
  canvas.width = PX_PER_UNIVERSE;
  canvas.height = keys.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(PX_PER_UNIVERSE, keys.length);
  keys.forEach((u, row) => {
    const data = universes.get(u)!;
    for (let p = 0; p < PX_PER_UNIVERSE; p++) {
      const c = p * 3;
      const o = (row * PX_PER_UNIVERSE + p) * 4;
      img.data[o] = data[c] || 0;
      img.data[o + 1] = data[c + 1] || 0;
      img.data[o + 2] = data[c + 2] || 0;
      img.data[o + 3] = 255;
    }
  });
  ctx.putImageData(img, 0, 0);
  return canvas;
}
