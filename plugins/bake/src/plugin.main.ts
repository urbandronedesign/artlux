// MAIN SIDE OF THE BAKE — the only part of a render that may touch a disk.
//
// It is deliberately dumb: pick a path, hold a file descriptor, write bytes where the muxer says to
// put them, close. Every decision about WHAT to write lives in the renderer, because that is where the
// pictures, the clock and the muxer are; a main half that understood frames would be a second place
// the output format is defined.
//
// POSITIONAL WRITES, NOT APPENDS. mediabunny's StreamTarget emits `{data, position}` because an MP4's
// `moov` is patched after the media is written — the byte offsets are not monotonic. An append-only
// writer produces a file that is the right size and unplayable.
//
// Why a file descriptor rather than accumulating and writing once: a ten-minute 1080p render is
// gigabytes, and holding it in either process before it reaches the disk is the difference between a
// render that works and one that dies at the end of a long job.

import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import { closeSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { dialog, BrowserWindow } from 'electron';
import { allowPath } from '../../../src/main/mediaAccess'; // host media-scheme seam (main-side, in-process)

interface OpenFile { fd: number; path: string }

const files = new Map<string, OpenFile>();
let chunks = 0, chunkBytes = 0, chunkMs = 0;

function closeFile(id: string): OpenFile | null {
  const f = files.get(id);
  if (!f) return null;
  files.delete(id);
  try { closeSync(f.fd); } catch { /* already gone */ }
  return f;
}

/** Close every open render. Called on deactivate so a quit mid-render cannot leak a descriptor. */
function closeAll(): void {
  for (const id of [...files.keys()]) closeFile(id);
}

export const bakeMainPlugin: MainPlugin = {
  manifest: { id: 'bake', name: 'Bake', version: '0.0.0' },

  activate(ctx: MainPluginContext) {
    // Where does this render go? Returns null when the operator cancels, and the renderer treats that
    // as "no render", not as an error.
    ctx.ipc.handle('bake:pick-output', async (...args: unknown[]) => {
      const suggested = typeof args[0] === 'string' ? args[0] : 'bake.mp4';
      const parent = (ctx.window() as BrowserWindow | null) ?? undefined;
      const res = parent
        ? await dialog.showSaveDialog(parent, {
            title: 'Bake surface to video',
            defaultPath: suggested,
            filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
          })
        : await dialog.showSaveDialog({ title: 'Bake surface to video', defaultPath: suggested });
      return res.canceled || !res.filePath ? null : res.filePath;
    });

    ctx.ipc.handle('bake:open', (...args: unknown[]) => {
      const id = String(args[0] ?? '');
      const path = String(args[1] ?? '');
      if (!id || !path) return false;
      closeFile(id); // a re-open under a live id would leak the previous descriptor
      try {
        // A render defaults into the project's own assets/video, which on a fresh project does not
        // exist yet. Creating it here rather than making the caller check keeps "where does this go"
        // one decision instead of two.
        mkdirSync(dirname(path), { recursive: true });
        files.set(id, { fd: openSync(path, 'w'), path });
        return true;
      } catch (e) {
        console.warn('[bake] could not open', path, (e as Error).message);
        return false;
      }
    });

    // Fire-and-forget: chunks arrive in a stream and a round trip per chunk would halve the render
    // rate. A write that fails is reported when the renderer closes the file, which is the first
    // moment it can do anything about it anyway.
    ctx.ipc.on('bake:chunk', (...args: unknown[]) => {
      const id = String(args[0] ?? '');
      const data = args[1] as Uint8Array | undefined;
      const position = Number(args[2] ?? 0);
      const f = files.get(id);
      if (!f || !data || !(data instanceof Uint8Array)) return;
      const t0 = Date.now();
      try {
        writeSync(f.fd, data, 0, data.byteLength, position);
      } catch (e) {
        console.warn('[bake] write failed', (e as Error).message);
      }
      chunks++; chunkBytes += data.byteLength; chunkMs += Date.now() - t0;
    });

    ctx.ipc.handle('bake:close', (...args: unknown[]) => {
      const f = closeFile(String(args[0] ?? ''));
      // ADMIT IT TO THE MEDIA SCHEME. Everything the renderer can read goes through an allowlist, and a
      // file just written is not on it — so without this the render succeeds and then nothing in the
      // app can open its own output. It fails as a 403, which downstream is indistinguishable from a
      // file that cannot be decoded, so it would be read as "the render produced a broken video".
      if (f) allowPath(f.path);
      console.info(`[bake] wrote ${chunks} chunks, ${(chunkBytes / 1e6).toFixed(2)}MB, ${chunkMs}ms in writeSync`);
      chunks = 0; chunkBytes = 0; chunkMs = 0;
      return f ? f.path : null;
    });

    // A cancelled render leaves no half file behind: a 400 MB MP4 that plays for nine of its ten
    // minutes and then stops is worse than no file, because it looks like a finished one.
    ctx.ipc.on('bake:cancel', (...args: unknown[]) => {
      const f = closeFile(String(args[0] ?? ''));
      if (f) { try { unlinkSync(f.path); } catch { /* never existed */ } }
    });
  },

  deactivate() { closeAll(); },

  status: () => ({ state: 'ok', detail: 'render writer ready' }),
};
