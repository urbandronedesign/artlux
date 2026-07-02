import type { SpoutFrame } from './types';

// Receives Spout frames (downscaled RGBA) from the plugin's main entry over the generic plugin IPC
// bridge and assembles them into a canvas usable as surface content — mirrors ndiReceiver.ts.
// Channels: 'spout:configure' (send), 'spout:frame' (on), 'spout:list' (invoke).

let unsub: (() => void) | null = null;
let canvas: HTMLCanvasElement | null = null;
let imageData: ImageData | null = null;
let latest: SpoutFrame | null = null;

export function startSpout(name: string): void {
  if (typeof window === 'undefined' || !window.artlux) return;
  window.artlux.pluginSend?.('spout:configure', { enabled: true, name });
  if (!unsub) {
    unsub = window.artlux.pluginOn?.('spout:frame', (f) => { latest = f as SpoutFrame; }) ?? null;
  }
}

export function stopSpout(): void {
  window.artlux?.pluginSend?.('spout:configure', { enabled: false });
  unsub?.();
  unsub = null;
  latest = null;
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
export function getSpoutCanvas(): HTMLCanvasElement | null {
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
