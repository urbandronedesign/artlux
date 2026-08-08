import type { SpoutFrame, SpoutTextureMeta } from './types';

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

// ── THE GPU PATH ────────────────────────────────────────────────────────────────────────────────
// When main can hand over the texture itself, frames arrive as VideoFrames on the preload's relay
// instead of as pixels over IPC. A VideoFrame IS a CanvasImageSource, so getSpoutCanvas returns it
// directly and every consumer — the compositor's atlas, the projector window — draws it unchanged.
//
// ⚠ EVERY FRAME MUST BE CLOSED. These are references to GPU images; the preload already dropped its
// own. Holding the newest and closing the one it replaces is the whole discipline — miss it and a
// 1080p allocation leaks per frame, which at 30 Hz exhausts VRAM in seconds.
let texture: VideoFrame | null = null;
let textureMeta: SpoutTextureMeta | null = null;
let unsubTexture: (() => void) | null = null;

function releaseTexture(): void {
  try { texture?.close(); } catch { /* already closed */ }
  texture = null;
  textureMeta = null;
}

function onRelayMessage(e: MessageEvent): void {
  const d = e.data as { kind?: string; channel?: string; meta?: SpoutTextureMeta; frame?: VideoFrame };
  if (d?.kind !== 'artlux:shared-texture' || d.channel !== 'spout' || !d.frame) return;
  // Replace, never accumulate: the previous frame goes back to the GPU the moment a newer one lands.
  try { texture?.close(); } catch { /* already closed */ }
  texture = d.frame;
  textureMeta = d.meta ?? null;
  seq++;
}

/** Is the GPU path even possible in this window? False ⇒ ask main for pixels. */
export function gpuSupported(): boolean {
  return typeof window !== 'undefined' && window.artlux?.sharedTextureSupported === true;
}

// `fps` is the poll rate main should run — the renderer's engine rate, because that is what consumes
// the frames. Re-calling with the same name and a new rate re-arms main's timer without reconnecting.
export function startSpout(name: string, fps?: number): void {
  if (typeof window === 'undefined' || !window.artlux) return;
  const gpu = gpuSupported();
  window.artlux.pluginSend?.('spout:configure', { enabled: true, name, fps, gpu });
  if (!unsub) {
    unsub = window.artlux.pluginOn?.('spout:frame', (f) => {
      // A CPU frame arriving means main fell back (import failure / another GPU). Drop the stale
      // texture so getSpoutCanvas stops preferring a picture that is no longer being updated.
      if (texture) releaseTexture();
      latest = f as SpoutFrame;
      seq++;
    }) ?? null;
  }
  // The relay is a window message, not an IPC channel — see the preload's shared-texture section.
  if (gpu && !unsubTexture) {
    window.addEventListener('message', onRelayMessage);
    unsubTexture = () => window.removeEventListener('message', onRelayMessage);
  }
}

export function stopSpout(): void {
  window.artlux?.pluginSend?.('spout:configure', { enabled: false });
  unsub?.();
  unsub = null;
  unsubTexture?.();
  unsubTexture = null;
  releaseTexture();
  latest = null;
  painted = -1;
}

export async function listSpoutSenders(): Promise<string[]> {
  return ((await window.artlux?.pluginInvoke?.('spout:list')) as string[] | undefined) ?? [];
}

// The active sender's true aspect ratio (w/h), or null until a frame arrives.
export function getSpoutAspect(): number | null {
  if (textureMeta?.width && textureMeta.height) return textureMeta.width / textureMeta.height;
  if (!latest || !latest.srcWidth || !latest.srcHeight) return null;
  return latest.srcWidth / latest.srcHeight;
}

// The latest Spout frame as something drawable, or null if none yet.
//
// On the GPU path this is the VideoFrame itself — a CanvasImageSource, so it needs no canvas, no
// upload and no conversion. Preferred over any CPU frame: when both exist the texture is the live
// one, because main sends pixels only after the GPU path has been abandoned (and that handler
// releases the texture, so "both" does not persist).
export function getSpoutCanvas(): CanvasImageSource | null {
  if (texture) return texture;
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
