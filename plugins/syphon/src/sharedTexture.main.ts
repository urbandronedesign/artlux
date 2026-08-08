// Main-process half of the Syphon GPU path: take the IOSurface the addon handed us, import it as an
// Electron shared texture, and hand it to the renderer's frame — where it becomes a VideoFrame with
// the pixels never having left the GPU.
//
// The Spout twin of this file needs a DXGI→pixel-format table and a re-shared NT handle. Neither
// exists here: Syphon publishes BGRA and nothing else (asserted in the addon), and an IOSurface is
// what Electron wants on darwin, so the server's own surface goes straight across.
//
// ⚠ WE DO NOT RELEASE THE SURFACE HERE, AND THAT IS DELIBERATE. Electron RETAINS it on import
// (Chromium's electron_api_shared_texture.cc: `ScopedCFTypeRef(io_surface, scoped_policy::RETAIN)`),
// so our +1 is unaffected by anything that happens in this file — success, failure or throw. The
// release therefore belongs in the poll's `finally`, where it runs on every path, and not on the
// happy path here. See syphonManager.arm().

import { sharedTexture, type BrowserWindow } from 'electron';
import type { SyphonShare, SyphonTextureMeta } from './types';

/** Names this producer on the preload's generic shared-texture relay. */
export const CHANNEL = 'syphon';

let warned = false;
let announced = false;

/**
 * Import + deliver one frame.
 *
 * Returns FALSE only for a failure that will keep happening — an import the GPU refused — which
 * tells the caller to abandon the GPU path for this connection. A missing window returns TRUE:
 * there is nothing to send to, but equally nothing to fall back to, and treating a closing window as
 * an import failure would leave the app permanently disabled after any reload.
 */
export function deliver(win: BrowserWindow | null, s: SyphonShare): boolean {
  // ⚠ Check the WINDOW, not just the frame. During teardown the poll keeps firing while the render
  // frame is being disposed, and `sendSharedTexture` then fails with "Render frame was disposed
  // before WebFrameMain could be accessed" — logged INTERNALLY by Electron, not thrown, so a
  // try/catch around the send sees nothing and would report a delivery that never happened.
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return true;
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
        // Always. Syphon servers publish kCVPixelFormatType_32BGRA and the addon refuses anything
        // else rather than letting it be reinterpreted, so there is no format to negotiate.
        pixelFormat: 'bgra',
        codedSize: { width: s.width, height: s.height },
        visibleRect: { x: 0, y: 0, width: s.width, height: s.height },
        handle: { ioSurface: Buffer.from(s.surface) },
      },
    });
    const meta: SyphonTextureMeta = { width: s.width, height: s.height };
    // Ownership of the IMPORT moves to the renderer here: the preload releases it once it has taken
    // its VideoFrame. Our IOSurface reference is a separate thing and is released by the caller.
    sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imported }, CHANNEL, meta);
    if (!announced) {
      // Worth one line: the two paths look identical on screen when they work, so without this there
      // is no way to tell which one a machine is actually running.
      console.log(`[syphon] GPU shared-texture path active — ${s.width}x${s.height} bgra, no readback`);
      announced = true;
    }
    return true;
  } catch (e) {
    try { imported?.release(); } catch { /* already gone */ }
    // A frame disposed mid-teardown is not an import failure — the app is closing. Latching Syphon
    // off for it would mean any reload silently disabled the next run.
    if (/disposed|destroyed/i.test((e as Error)?.message ?? '')) return true;
    if (!warned) { console.warn('[syphon] shared-texture import failed:', (e as Error)?.message ?? e); warned = true; }
    return false;
  }
}

/** Is this Electron capable of the GPU path at all? */
export function available(): boolean {
  return typeof sharedTexture?.importSharedTexture === 'function'
    && typeof sharedTexture?.sendSharedTexture === 'function';
}
