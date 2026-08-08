import type { SpoutIncompatibility, SpoutTextureMeta } from './types';

// Receives Spout frames as GPU TEXTURES from the plugin's main entry and holds the newest one for the
// compositor to draw. There is no pixel path: main hands over a shared texture, the preload turns it
// into a VideoFrame, and a VideoFrame IS a CanvasImageSource — so it goes straight to every consumer
// (the compositor's atlas, a projector window) with no canvas, no upload and no conversion.
//
// The frames do NOT arrive on the plugin IPC bridge. A shared texture cannot be structured-cloned, so
// they come over the preload's shared-texture relay as a window message. Bridge channels still carry
// everything else: 'spout:configure' (send), 'spout:list' (invoke), 'spout:incompatible' (on).
//
// ⚠ EVERY FRAME MUST BE CLOSED. These are references to GPU images and the preload has already
// dropped its own. Miss a close and a full-resolution allocation leaks per frame, which at 60 Hz
// exhausts VRAM in seconds rather than hours.
//
// CLOSING ON REPLACEMENT IS SAFE, INCLUDING FOR ASYNC READERS — MEASURED, DON'T "FIX" IT.
// The worry is obvious and wrong: the projector pump reads a drawable with `createImageBitmap`
// (App.tsx) and AWAITS the copy, so closing the frame underneath it looks like it must reject the
// promise — silently, since the pump catches — and show up as a projector output dropping frames
// while the editor preview looks fine. It does not happen. `createImageBitmap` takes its own
// reference to the underlying image, so a later close cannot invalidate a copy already in flight.
// Verified against REAL imported shared textures (not canvas-backed stand-ins, which prove nothing
// here — an imported frame's GPU image is externally owned): 181 frames closed immediately after the
// call, 181 bitmaps resolved, 0 rejections. A retirement queue holding superseded frames for a few
// frames was written to defend this and then removed, because it defends nothing and costs a
// full-resolution GPU image per slot.

let texture: VideoFrame | null = null;
let textureMeta: SpoutTextureMeta | null = null;
let unsubTexture: (() => void) | null = null;
let unsubIncompatible: (() => void) | null = null;
let incompatible: SpoutIncompatibility | null = null;
const listeners = new Set<() => void>();

function close(f: VideoFrame | null): void {
  try { f?.close(); } catch { /* already closed */ }
}

function releaseTexture(): void {
  close(texture);
  texture = null;
  textureMeta = null;
}

function onRelayMessage(e: MessageEvent): void {
  const d = e.data as { kind?: string; channel?: string; meta?: SpoutTextureMeta; frame?: VideoFrame };
  if (d?.kind !== 'artlux:shared-texture' || d.channel !== 'spout' || !d.frame) return;
  // Replace, and give the outgoing frame straight back to the GPU. Safe for async readers too — see
  // the measurement at the top of this file before adding any grace period here.
  close(texture);
  texture = d.frame;
  textureMeta = d.meta ?? null;
  if (incompatible) { incompatible = null; listeners.forEach((l) => l()); } // a picture disproves it
}

/**
 * Why Spout cannot run here, or null when it is fine.
 *
 * Spout is GPU-only by design — see spoutManager for why there is no readback path — so this is the
 * difference between a picture and no picture, and the editor shows it rather than leaving an
 * operator staring at an empty surface.
 */
export function spoutIncompatibility(): SpoutIncompatibility | null { return incompatible; }

/** Subscribe to incompatibility changes (for the editor's status line). */
export function onSpoutStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// `fps` raises the poll FLOOR only; main polls the sender's rate. Re-calling with the same name and a
// new rate re-arms main's timer without reconnecting.
export function startSpout(name: string, fps?: number): void {
  if (typeof window === 'undefined' || !window.artlux) return;
  // The window's own capability. Main checks its side too; this one catches an Electron whose main
  // process has the API while the renderer cannot be handed anything.
  if (window.artlux.sharedTextureSupported !== true) {
    incompatible = 'no-shared-texture';
    listeners.forEach((l) => l());
    return;
  }
  window.artlux.pluginSend?.('spout:configure', { enabled: true, name, fps });
  if (!unsubIncompatible) {
    unsubIncompatible = window.artlux.pluginOn?.('spout:incompatible', (why) => {
      incompatible = why as SpoutIncompatibility;
      releaseTexture(); // nothing will refresh it now; a frozen last frame would read as "working"
      listeners.forEach((l) => l());
    }) ?? null;
  }
  // The relay is a window message, not an IPC channel — see the preload's shared-texture section.
  if (!unsubTexture) {
    window.addEventListener('message', onRelayMessage);
    unsubTexture = () => window.removeEventListener('message', onRelayMessage);
  }
}

export function stopSpout(): void {
  window.artlux?.pluginSend?.('spout:configure', { enabled: false });
  unsubTexture?.();
  unsubTexture = null;
  unsubIncompatible?.();
  unsubIncompatible = null;
  releaseTexture();
}

export async function listSpoutSenders(): Promise<string[]> {
  return ((await window.artlux?.pluginInvoke?.('spout:list')) as string[] | undefined) ?? [];
}

/** The active sender's aspect ratio (w/h), or null until a frame arrives. */
export function getSpoutAspect(): number | null {
  if (textureMeta?.width && textureMeta.height) return textureMeta.width / textureMeta.height;
  return null;
}

/** The latest Spout frame, or null if none yet. Already a CanvasImageSource — nothing to convert. */
export function getSpoutCanvas(): CanvasImageSource | null {
  return texture;
}
