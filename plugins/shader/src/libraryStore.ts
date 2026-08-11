// The effect library, on disk. MAIN PROCESS ONLY — the renderer has no fs.
//
//   userData/shaders/<Effect name>/
//     shader.frag      the code, header and all
//     values.json      this effect's parameter values + which built-in it started from
//     graph.json       the node graph, when the effect was built in the node editor
//     thumbnail.png    rendered once, on save
//
// A FOLDER PER EFFECT, following MadMapper, and simpler than the index-plus-cache an earlier draft of
// the plan proposed: export is a folder copy, import is a folder copy, thumbnails are files rather
// than a cache to invalidate, and there is no index that can disagree with the tree.
//
// WHY THE LIBRARY IS NEVER ON THE RENDER PATH. A venue machine has a different userData, so a project
// that resolved its content from here would render black on the night — and nothing on the authoring
// machine would say so. The original plan answered that with copy-in to the project's assets folder;
// storing the shader TEXT inline in the project answered it more strongly first, because a project
// then carries its shaders with it and has no file left to lose. So this library is a palette an
// operator picks FROM, and applying an effect copies its text into the surface. Nothing reads it while
// a show is running.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LibraryEntry {
  /** The folder name, which is also the effect's name. */
  name: string;
  source: string;
  params: Record<string, number | boolean | number[]>;
  /** Which built-in it was derived from, for the Reset action. */
  shaderId?: string;
  /** The node graph, when this effect was built in the node editor. Absent for hand-written code. */
  graph?: string;
  /** A data: URI, or null when the folder has no thumbnail yet. */
  thumbnail: string | null;
  savedAt: number;
}

function root(): string {
  return path.join(app.getPath('userData'), 'shaders');
}

/**
 * A folder name we are willing to create. An effect is named by the operator, and a name is not a
 * path: `../../autoexec` is a name too. Everything outside this set is replaced rather than rejected,
 * so naming an effect "Wave / 2" works instead of failing.
 */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 64);
  return cleaned || 'Untitled';
}

export function list(): LibraryEntry[] {
  const dir = root();
  if (!fs.existsSync(dir)) return [];
  const out: LibraryEntry[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    try {
      const folder = path.join(dir, e.name);
      const source = fs.readFileSync(path.join(folder, 'shader.frag'), 'utf8');
      let params: Record<string, number | boolean | number[]> = {};
      let shaderId: string | undefined;
      let savedAt = 0;
      const valuesPath = path.join(folder, 'values.json');
      if (fs.existsSync(valuesPath)) {
        const v = JSON.parse(fs.readFileSync(valuesPath, 'utf8')) as Record<string, unknown>;
        params = (v.params as typeof params) ?? {};
        shaderId = typeof v.shaderId === 'string' ? v.shaderId : undefined;
        savedAt = typeof v.savedAt === 'number' ? v.savedAt : 0;
      }
      // The graph is OPTIONAL and its absence is meaningful, not a defect: an effect saved from the
      // code editor has none, and applying it must therefore CLEAR whatever graph the target surface
      // had — a graph left behind would describe a shader that is no longer there.
      const graphPath = path.join(folder, 'graph.json');
      const graph = fs.existsSync(graphPath) ? fs.readFileSync(graphPath, 'utf8') : undefined;

      const thumbPath = path.join(folder, 'thumbnail.png');
      const thumbnail = fs.existsSync(thumbPath)
        ? `data:image/png;base64,${fs.readFileSync(thumbPath).toString('base64')}`
        : null;
      out.push({ name: e.name, source, params, shaderId, graph, thumbnail, savedAt });
    } catch (err) {
      // ONE BAD FOLDER MUST NOT EMPTY THE LIBRARY. A half-written entry, a folder someone dropped in
      // by hand, a shader.frag deleted — skip it and keep the rest, because a browser that shows
      // nothing reads as "my work is gone" rather than "one of these is broken".
      console.warn('[shader] skipping unreadable library entry', e.name, (err as Error).message);
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function save(input: {
  name: string;
  source: string;
  params: Record<string, number | boolean | number[]>;
  shaderId?: string;
  graph?: string;
  /** A `data:image/png;base64,…` URI rendered by the renderer, or null. */
  thumbnail?: string | null;
}): { ok: boolean; name: string; error?: string } {
  try {
    const name = safeName(input.name);
    const folder = path.join(root(), name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'shader.frag'), input.source, 'utf8');
    fs.writeFileSync(
      path.join(folder, 'values.json'),
      JSON.stringify({ params: input.params, shaderId: input.shaderId, savedAt: Date.now() }, null, 2),
      'utf8',
    );
    // Re-saving a graph effect as code must not leave the old graph.json behind to be re-applied.
    const graphFile = path.join(folder, 'graph.json');
    if (input.graph) fs.writeFileSync(graphFile, input.graph, 'utf8');
    else if (fs.existsSync(graphFile)) fs.rmSync(graphFile);

    if (input.thumbnail?.startsWith('data:image/png;base64,')) {
      const b64 = input.thumbnail.slice('data:image/png;base64,'.length);
      fs.writeFileSync(path.join(folder, 'thumbnail.png'), Buffer.from(b64, 'base64'));
    }
    return { ok: true, name };
  } catch (e) {
    return { ok: false, name: input.name, error: (e as Error).message };
  }
}

export function remove(name: string): { ok: boolean; error?: string } {
  try {
    const folder = path.join(root(), safeName(name));
    // Resolve and re-check: safeName strips the obvious traversals, and this refuses anything that
    // still lands outside the library root. Deleting recursively deserves both.
    if (path.relative(root(), folder).startsWith('..')) return { ok: false, error: 'outside the library' };
    fs.rmSync(folder, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** For "Reveal in folder" and for telling the operator where their work actually lives. */
export function folderPath(): string {
  return root();
}

/** Make sure the folder exists before revealing it — opening a path that is not there does nothing. */
export function ensureFolder(): string {
  const dir = root();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
