import type { NdiFrame } from './types';

// Receives NDI frames (downscaled RGBA) from the plugin's main entry over the generic plugin IPC
// bridge and assembles them into a canvas usable as surface content — mirrors spoutReceiver.ts.
// Channels: 'ndi:configure' (send), 'ndi:frame' (on), 'ndi:list' / 'ndi:available' (invoke).

let unsub: (() => void) | null = null;
let canvas: HTMLCanvasElement | null = null;
let imageData: ImageData | null = null;
let latest: NdiFrame | null = null;

export function startNdi(name: string): void {
  if (typeof window === 'undefined' || !window.artlux) return;
  window.artlux.pluginSend?.('ndi:configure', { enabled: true, name });
  if (!unsub) {
    unsub = window.artlux.pluginOn?.('ndi:frame', (f) => { latest = f as NdiFrame; }) ?? null;
  }
}

export function stopNdi(): void {
  window.artlux?.pluginSend?.('ndi:configure', { enabled: false });
  unsub?.();
  unsub = null;
  latest = null;
}

export async function listNdiSources(): Promise<string[]> {
  return ((await window.artlux?.pluginInvoke?.('ndi:list')) as string[] | undefined) ?? [];
}

export async function ndiAvailable(): Promise<boolean> {
  return ((await window.artlux?.pluginInvoke?.('ndi:available')) as boolean | undefined) ?? false;
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
