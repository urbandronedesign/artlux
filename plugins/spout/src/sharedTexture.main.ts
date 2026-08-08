// Main-process half of the Spout GPU path: take the NT handle the addon re-shared, import it as an
// Electron shared texture, and hand it to the renderer's frame — where it becomes a VideoFrame with
// the pixels never having left the GPU.
//
// The CPU path this replaces reads the texture back to system memory (~9 ms of main-thread stall at
// 1080p) and then structured-clones 8.3 MB per frame across IPC. This sends a handle.

import { sharedTexture, type BrowserWindow } from 'electron';
import type { SpoutShare, SpoutTextureMeta } from './types';

/** Names this producer on the preload's generic shared-texture relay. */
export const CHANNEL = 'spout';

// DXGI_FORMAT → the pixel format names Electron accepts. Anything else we simply cannot describe, so
// the caller falls back rather than importing a texture that would be read as the wrong bytes.
function pixelFormat(dxgi: number): 'bgra' | 'rgba' | null {
  if (dxgi === 87) return 'bgra'; // B8G8R8A8_UNORM — Spout's usual
  if (dxgi === 28) return 'rgba'; // R8G8B8A8_UNORM
  return null;
}

let warned = false;
let announced = false;

/**
 * Import + deliver one frame.
 *
 * Returns FALSE only for a failure that will keep happening — an unusable format, or an import the
 * GPU refused — which tells the caller to abandon the GPU path for this connection. A missing window
 * returns TRUE: there is nothing to send to, but there is equally nothing to fall back to, and
 * treating a closing window as an import failure would leave the app permanently on the CPU path
 * after any reload.
 *
 * The import is per-frame by design. It is cheap — 20 import+release cycles measured at 2 ms total —
 * and it gives the compositor a fresh reference whose lifetime it controls, rather than us mutating
 * a texture it may be reading.
 */
export function deliver(win: BrowserWindow | null, s: SpoutShare): boolean {
  // ⚠ Check the WINDOW, not just the frame. During teardown the poll keeps firing while the render
  // frame is being disposed, and `sendSharedTexture` then fails with "Render frame was disposed
  // before WebFrameMain could be accessed" — logged INTERNALLY by Electron, not thrown, so a
  // try/catch around the send sees nothing and would report a delivery that never happened.
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return true;
  const fmt = pixelFormat(s.format);
  if (!fmt) {
    if (!warned) { console.warn(`[spout] unsupported DXGI format ${s.format} for GPU path`); warned = true; }
    return false;
  }
  let imported: Electron.SharedTextureImported | null = null;
  try {
    const frame = win.webContents.mainFrame;
    if (!frame) return true; // same reasoning as the destroyed-window check above
    // Liveness probe. A frame can be disposed while its window still reports itself alive, and the
    // failure then surfaces inside sendSharedTexture where Electron logs it instead of throwing.
    // Touching a property here converts that into an exception we can see, before we import.
    void frame.url;
    imported = sharedTexture.importSharedTexture({
      textureInfo: {
        pixelFormat: fmt,
        codedSize: { width: s.width, height: s.height },
        visibleRect: { x: 0, y: 0, width: s.width, height: s.height },
        handle: { ntHandle: Buffer.from(s.handle) },
      },
    });
    const meta: SpoutTextureMeta = { width: s.width, height: s.height };
    // Ownership moves to the renderer here: the preload releases this import once it has taken its
    // VideoFrame, so there is nothing left for us to release afterwards.
    sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, CHANNEL, meta);
    if (!announced) {
      // Worth one line: the two paths look identical on screen when they work, so without this there
      // is no way to tell which one a machine is actually running.
      console.log(`[spout] GPU shared-texture path active — ${s.width}x${s.height} ${fmt}, no readback`);
      announced = true;
    }
    return true;
  } catch (e) {
    try { imported?.release(); } catch { /* already gone */ }
    // A frame disposed mid-teardown is not an import failure — the app is closing. Latching the GPU
    // path off for it would mean any reload silently demoted the next run to the CPU path.
    if (/disposed|destroyed/i.test((e as Error)?.message ?? '')) return true;
    // The commonest real cause is a handle we cannot duplicate — a sender on another GPU. Report it
    // once; the caller latches off and the picture continues over the CPU path.
    if (!warned) { console.warn('[spout] shared-texture import failed:', (e as Error)?.message ?? e); warned = true; }
    return false;
  }
}

/** Is this Electron capable of the GPU path at all? */
export function available(): boolean {
  return typeof sharedTexture?.importSharedTexture === 'function'
    && typeof sharedTexture?.sendSharedTexture === 'function';
}
