import type { SpoutFrame } from './types';

// Receives Spout frames (downscaled RGBA) from the plugin's main entry over the generic plugin IPC
// bridge and assembles them into a canvas usable as surface content — mirrors ndiReceiver.ts.
// Channels: 'spout:configure' (send), 'spout:frame' (on), 'spout:list' (invoke).

let unsub: (() => void) | null = null;
// OffscreenCanvas, not a DOM element: this is never displayed — it exists to be sampled — and an
// OffscreenCanvas is the version that can live in a worker once the engine moves there. Falls back to
// a detached <canvas> where the API is missing.
let canvas: OffscreenCanvas | HTMLCanvasElement | null = null;
let ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null = null;
let imageData: ImageData | null = null;
let latest: SpoutFrame | null = null;
// `seq` counts arrivals, `painted` records which one the canvas holds. getSpoutCanvas() is called once
// per consuming surface AND again inside the GPU sampler's per-surface closure, so without this the
// same unchanged bytes were re-packed and re-uploaded several times per frame — and on every frame
// while the sender sat idle, which for a paused Spout source is all of them.
let seq = 0;
let painted = -1;

// `fps` is the poll rate main should run — the renderer's engine rate, because that is what consumes
// the frames. Re-calling with the same name and a new rate re-arms main's timer without reconnecting.
export function startSpout(name: string, fps?: number): void {
  if (typeof window === 'undefined' || !window.artlux) return;
  window.artlux.pluginSend?.('spout:configure', { enabled: true, name, fps });
  if (!unsub) {
    unsub = window.artlux.pluginOn?.('spout:frame', (f) => { latest = f as SpoutFrame; seq++; }) ?? null;
  }
}

export function stopSpout(): void {
  window.artlux?.pluginSend?.('spout:configure', { enabled: false });
  unsub?.();
  unsub = null;
  latest = null;
  painted = -1;
}

export async function listSpoutSenders(): Promise<string[]> {
  return ((await window.artlux?.pluginInvoke?.('spout:list')) as string[] | undefined) ?? [];
}

// The active sender's true aspect ratio (w/h), or null until a frame arrives.
export function getSpoutAspect(): number | null {
  if (!latest || !latest.srcWidth || !latest.srcHeight) return null;
  return latest.srcWidth / latest.srcHeight;
}

// Returns a canvas with the latest Spout frame, or null if none yet.
export function getSpoutCanvas(): OffscreenCanvas | HTMLCanvasElement | null {
  if (!latest) return null;
  const { width, height, data } = latest;
  if (width <= 0 || height <= 0) return null;
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    imageData = null;
    painted = -1; // a new canvas holds nothing
  }
  if (!ctx) return null;
  if (painted === seq) return canvas; // no new frame since the last paint
  if (!imageData) imageData = ctx.createImageData(width, height);
  imageData.data.set(data);
  ctx.putImageData(imageData, 0, 0);
  painted = seq;
  return canvas;
}
