// Typed renderer-side client for the bake plugin's own IPC. One place that knows the channel names,
// so a rename is one edit rather than a search for string literals across the render loop.
//
// The host namespaces everything under `plugin:<channel>` (see the preload bridge); the plugin passes
// the bare channel.

import type { RendererPluginContext } from '@artlux/sdk/renderer';

type Ipc = RendererPluginContext['ipc'];

let ipc: Ipc | null = null;

/** Set once, by the renderer plugin's activate(). */
export function setIpc(v: Ipc): void { ipc = v; }

export async function pickOutput(suggestedName: string): Promise<string | null> {
  if (!ipc) return null;
  return ((await ipc.invoke('bake:pick-output', suggestedName)) as string | null) ?? null;
}

export async function open(id: string, path: string): Promise<boolean> {
  if (!ipc) return false;
  return (await ipc.invoke('bake:open', id, path)) === true;
}

/**
 * Fire-and-forget, deliberately: a round trip per chunk would halve the render rate, and there is
 * nothing useful to do about a failed write until the file is closed anyway.
 *
 * ⚠ COPY, NEVER TRANSFER. Electron's renderer→main port silently delivers `null` for a transferred
 * ArrayBuffer — the message arrives, on time, with no data and no error (see engine/framePort). The
 * structured clone this takes is a copy, which is what we want.
 */
export function chunk(id: string, data: Uint8Array, position: number): void {
  ipc?.send('bake:chunk', id, data, position);
}

export async function close(id: string): Promise<string | null> {
  if (!ipc) return null;
  return ((await ipc.invoke('bake:close', id)) as string | null) ?? null;
}

/** Abandon a render: closes the descriptor and deletes the partial file. */
export function cancelWrite(id: string): void {
  ipc?.send('bake:cancel', id);
}
