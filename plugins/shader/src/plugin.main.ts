// Shader plugin — main-process half.
//
// It exists for one reason: the renderer has no filesystem, and an effect library is files. Everything
// that draws is still renderer-side; this is a door to a folder.

import { shell } from 'electron';
import type { MainPlugin, MainPluginContext } from '@artlux/sdk/main';
import * as libraryStore from './libraryStore';
import * as subpatchStore from './subpatchStore';

export const plugin: MainPlugin = {
  manifest: { id: 'shader', name: 'Shaders', version: '0.0.0' },

  activate(ctx: MainPluginContext): void {
    // Channels are namespaced 'plugin:<ch>' by the host. Everything here is request/response — the
    // library is touched when an operator acts, never per frame.
    ctx.ipc.handle('shader:library:list', async () => libraryStore.list());

    ctx.ipc.handle('shader:library:save', async (input: unknown) =>
      libraryStore.save(input as Parameters<typeof libraryStore.save>[0]));

    ctx.ipc.handle('shader:library:delete', async (name: unknown) => libraryStore.remove(String(name)));

    // Subpatches are their own library: one JSON file each, because a subpatch is one object where
    // an effect is code, values and a thumbnail. Same rule as the effects, though — using one COPIES
    // it into the project, so nothing here is ever read while a show runs.
    ctx.ipc.handle('shader:subpatch:list', async () => subpatchStore.list());
    ctx.ipc.handle('shader:subpatch:save', async (input: unknown) =>
      subpatchStore.save(input as Parameters<typeof subpatchStore.save>[0]));
    ctx.ipc.handle('shader:subpatch:delete', async (name: unknown) => subpatchStore.remove(String(name)));

    ctx.ipc.handle('shader:library:reveal', async () => {
      // Create it first: "Reveal in folder" on a folder that does not exist yet opens nothing at all
      // on Windows, which reads as the button being broken rather than the library being empty.
      const dir = libraryStore.ensureFolder();
      await shell.openPath(dir).catch(() => undefined);
      return dir;
    });
  },

  // Nothing to be unsure about: no device, no addon, no socket. A folder either has entries or does
  // not, and an empty library is not a fault.
  status: () => ({ state: 'ok', detail: 'effect library' }),
};
