import type { NdiFrame } from '../../../shared/protocol';

// Receives NDI frames (downscaled RGBA) from the main process and assembles them into a
// canvas usable as surface content — mirrors spoutReceiver.ts.

let unsub: (() => void) | null = null;
let canvas: HTMLCanvasElement | null = null;
let imageData: ImageData | null = null;
let latest: NdiFrame | null = null;

export function startNdi(name: string): void {
  if (typeof window === 'undefined' || !window.artlux) return;
  window.artlux.configureNdi?.({ enabled: true, name });
  if (!unsub) {
    unsub = window.artlux.onNdiFrame?.((f) => { latest = f; }) ?? null;
  }
}

export function stopNdi(): void {
  window.artlux?.configureNdi?.({ enabled: false });
  unsub?.();
  unsub = null;
  latest = null;
}

export async function listNdiSources(): Promise<string[]> {
  return (await window.artlux?.listNdiSources?.()) ?? [];
}

export async function ndiAvailable(): Promise<boolean> {
  return (await window.artlux?.ndiAvailable?.()) ?? false;
}

// The active source's true aspect ratio (w/h), or null until a frame arrives.
export function getNdiAspect(): number | null {
  if (!latest || !latest.srcWidth || !latest.srcHeight) return null;
  return latest.srcWidth / latest.srcHeight;
}

// Returns a canvas with the latest NDI frame, or null if none yet.
export function getNdiCanvas(): HTMLCanvasElement | null {
  if (!latest) return null;
  const { width, height, data } = latest;
  if (width <= 0 || height <= 0) return null;
  if (!canvas) canvas = document.createElement('canvas');
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    imageData = null;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (!imageData) imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}
