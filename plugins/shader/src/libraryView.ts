// The shader panels' view of what only the editor's runtime has (E5/W5): the GL compile, and the effect
// and subpatch libraries (their files are main's, their thumbnails are rendered on the editor's GL
// context, and their list is one store in the editor).
//
// The Shader, Shader Nodes and Effects panels are the plugin's UI half: drawn in the editor and in a
// panel window. They ask through the live view (uiLink.ts) — answered locally in the editor, over the
// live channel in a window — so there is one code path and one library, whichever window the hand is in.
// The runtime side is plugin.renderer.ts ('shader.check', 'shader.library', …).
import { useLiveValue } from '@artlux/sdk/renderer';
import { liveView } from './uiLink';
import type { LibraryEntry, SaveResult, StoredSubpatch } from './libraryTypes';

export type { LibraryEntry, StoredSubpatch } from './libraryTypes';
export { contentPatch } from './libraryTypes';

const NONE: never[] = [];
const ask = async <T>(name: string, args: unknown[], fallback: T): Promise<T> => {
  const v = liveView();
  if (!v) return fallback;
  try { return ((await v.call(name, args)) as T) ?? fallback; } catch (e) {
    console.warn(`[shader] ${name} failed:`, (e as Error).message);
    return fallback;
  }
};

/** Compile a source on the editor's GL context, for its verdict only — the program stays there. */
export function checkShader(source: string): Promise<{ ok: boolean; log: string }> {
  return ask('shader.check', [source], { ok: false, log: 'the editor did not answer' });
}
/** An edit landed: give a previously disabled surface another chance at the frame budget. */
export function rearm(surfaceId: string): void { void ask('shader.rearm', [surfaceId], undefined); }

export function useLibrary(): LibraryEntry[] { return useLiveValue<LibraryEntry[]>(liveView(), 'shader.library', null, NONE); }
export function useSubpatches(): StoredSubpatch[] { return useLiveValue<StoredSubpatch[]>(liveView(), 'shader.subpatches', null, NONE); }

/** Save a surface's shader as a named effect (the editor resolves its live parameter values). */
export function saveEffect(name: string, surfaceId: string): Promise<SaveResult> {
  return ask('shader.librarySave', [name, surfaceId], { ok: false, name, error: 'the editor did not answer' });
}
export function removeEffect(name: string): Promise<void> { return ask('shader.libraryRemove', [name], undefined); }
export function revealLibrary(): Promise<void> { return ask('shader.libraryReveal', [], undefined); }
export function saveSubpatch(name: string, def: unknown): Promise<SaveResult> {
  return ask('shader.subpatchSave', [name, def], { ok: false, name, error: 'the editor did not answer' });
}
