// The renderer's view of the effect library: a thin client over the plugin IPC bridge, plus the
// thumbnail rendering that only the renderer can do (main has no GPU).
//
// A tiny store rather than a hook, because two places read the library (the browser panel and the
// editor's Save button) and both must see the same list the moment one of them changes it.

import type { SurfaceContent } from '@/types';
import type { PluginIpc } from '@artlux/sdk/renderer';
import { getProgram, renderToBitmap } from './shaderContext';
import { sourceOf } from './shaderSource';

export interface LibraryEntry {
  name: string;
  source: string;
  params: Record<string, number | boolean | number[]>;
  shaderId?: string;
  thumbnail: string | null;
  savedAt: number;
}

let ipc: PluginIpc | null = null;
let entries: LibraryEntry[] = [];
const subs = new Set<() => void>();

export function setIpc(handle: PluginIpc): void { ipc = handle; }
export function all(): LibraryEntry[] { return entries; }
export function subscribe(cb: () => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }
function emit(): void { for (const cb of subs) cb(); }

export async function refresh(): Promise<void> {
  if (!ipc) return;
  try {
    entries = (await ipc.invoke('shader:library:list')) as LibraryEntry[];
  } catch (e) {
    console.warn('[shader] library list failed', (e as Error).message);
    entries = [];
  }
  emit();
}

/**
 * A still of the shader, for the browser card.
 *
 * Rendered through the SAME context every surface uses — one context is the rule, and a thumbnail is
 * not an exception to it. Small (a card is ~160px), and taken at a fixed time rather than "now" so
 * saving the same effect twice produces the same picture instead of two frames of an animation.
 *
 * Sequential by construction: this is one function on one canvas, so a library of forty entries can
 * never be forty simultaneous renders.
 */
async function renderThumbnail(source: string, params: Map<string, number | number[]> | undefined): Promise<string | null> {
  const program = getProgram(source);
  if (!program.ok) return null;
  // A key of its own, so a thumbnail never disturbs a live surface's feedback history.
  const bmp = renderToBitmap(program, 256, 144, 2.5, params, 'library:thumbnail');
  if (!bmp) return null;
  try {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0);
    return c.toDataURL('image/png');
  } finally {
    bmp.close();
  }
}

/** Save a surface's shader as a named effect. Returns the name it was actually stored under. */
export async function saveFromContent(
  name: string,
  content: SurfaceContent,
  values: Map<string, number | number[]> | undefined,
): Promise<{ ok: boolean; name: string; error?: string }> {
  if (!ipc) return { ok: false, name, error: 'no ipc' };
  const source = sourceOf(content);
  const thumbnail = await renderThumbnail(source, values);
  const res = (await ipc.invoke('shader:library:save', {
    name,
    source,
    params: content.shaderParams ?? {},
    shaderId: content.shaderId,
    thumbnail,
  })) as { ok: boolean; name: string; error?: string };
  await refresh();
  return res;
}

export async function remove(name: string): Promise<void> {
  if (!ipc) return;
  await ipc.invoke('shader:library:delete', name);
  await refresh();
}

export async function reveal(): Promise<void> {
  await ipc?.invoke('shader:library:reveal');
}

/**
 * What applying a library effect writes onto a surface.
 *
 * The TEXT is copied in, not referenced. That is the whole safety property: a project carries its own
 * shaders, so it opens correctly on a venue machine whose userData holds a different library — or no
 * library at all. The cost is the honest one: editing a library entry does not retro-change shows that
 * already used it, which is correct, because a show that worked last night must work tonight.
 */
export function contentPatch(entry: LibraryEntry): Partial<SurfaceContent> {
  return {
    type: 'SHADER',
    shaderSource: entry.source,
    shaderParams: entry.params,
    shaderId: entry.shaderId,
  };
}
