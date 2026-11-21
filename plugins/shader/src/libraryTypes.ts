// The effect and subpatch libraries, as DATA: the shapes both halves agree on, and the one pure rule
// (what applying an effect writes). No GL, no IPC — the UI half imports this, and so does the runtime's
// library client (libraryClient.ts), which is where the files and the thumbnails are.
import type { SurfaceContent } from '@/types';

export interface LibraryEntry {
  name: string;
  source: string;
  params: Record<string, number | boolean | number[]>;
  shaderId?: string;
  graph?: string;
  thumbnail: string | null;
  savedAt: number;
}

export interface StoredSubpatch { name: string; def: unknown; savedAt: number }

export type SaveResult = { ok: boolean; name: string; error?: string };

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
    // undefined, not omitted: this patch is spread over the existing content, so leaving the key out
    // would keep the surface's previous graph next to the new effect's code — the node editor would
    // then show, and on the next edit re-generate, a shader nobody asked for.
    shaderGraph: entry.graph,
  };
}
