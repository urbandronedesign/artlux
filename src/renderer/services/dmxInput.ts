import { InputFrame } from '../../../shared/protocol';

// Receives incoming DMX universes from the main process and assembles them into a
// small canvas (one row per universe, RGB triples across) usable as a content
// source for the mapper — so incoming DMX drives fixtures like any other source.

const universes = new Map<number, Uint8Array>();
let unsub: (() => void) | null = null;

// OffscreenCanvas, not a DOM element: nothing here is ever displayed — it exists only to be sampled —
// and an OffscreenCanvas is the version of it that can live in a worker when the engine moves there.
// Falls back to a detached <canvas> if the API is missing.
let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
let img: ImageData | null = null;

// `seq` counts arrivals; `painted` records which one the canvas currently holds. getInputCanvas() is
// called once per consuming surface AND again inside the GPU sampler's per-surface closure, so without
// this the same unchanged bytes were re-packed and re-uploaded several times per frame — and every
// frame while the sender sat idle.
let seq = 0;
let painted = -1;

export function startInput(): void {
  if (unsub || typeof window === 'undefined' || !window.artlux) return;
  unsub = window.artlux.onDmxInput((frames: InputFrame[]) => {
    for (const f of frames) {
      const arr = universes.get(f.universe) ?? new Uint8Array(512);
      arr.set(f.data.slice(0, 512));
      universes.set(f.universe, arr);
    }
    seq++;
  });
}

export function stopInput(): void {
  unsub?.();
  unsub = null;
  universes.clear();
  painted = -1;
}

const PX_PER_UNIVERSE = 170; // 512 channels / 3 (RGB)

// Returns a canvas with current input (row = universe), or null if no data yet.
export function getInputCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
  if (universes.size === 0) return null;
  const keys = Array.from(universes.keys()).sort((a, b) => a - b);
  const h = keys.length;

  // Reuse the canvas, its context and its ImageData across frames; only the size can force a rebuild.
  if (!canvas || canvas.width !== PX_PER_UNIVERSE || canvas.height !== h) {
    canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(PX_PER_UNIVERSE, h)
      : Object.assign(document.createElement('canvas'), { width: PX_PER_UNIVERSE, height: h });
    ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    img = null;
    painted = -1; // a new canvas holds nothing
  }
  if (!ctx) return null;
  if (painted === seq) return canvas; // nothing new arrived — the canvas already shows it
  if (!img) img = ctx.createImageData(PX_PER_UNIVERSE, h);

  const d = img.data;
  for (let row = 0; row < h; row++) {
    const data = universes.get(keys[row])!;
    for (let p = 0; p < PX_PER_UNIVERSE; p++) {
      const c = p * 3;
      const o = (row * PX_PER_UNIVERSE + p) * 4;
      d[o] = data[c] || 0;
      d[o + 1] = data[c + 1] || 0;
      d[o + 2] = data[c + 2] || 0;
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  painted = seq;
  return canvas;
}
