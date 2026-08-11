// The subpatch library, on disk. MAIN PROCESS ONLY — the renderer has no fs.
//
//   userData/subpatches/<Name>.json      one file per subpatch, the definition verbatim
//
// A FILE RATHER THAN A FOLDER, unlike the effect library: an effect carries code, values and a
// thumbnail, while a subpatch is one JSON object. Sharing one is sending a file.
//
// NOTHING HERE IS ON THE RENDER PATH, for the same reason the effect library is not: a venue machine
// has a different userData, so a project that resolved part of its shader from here would render
// black on the night with nothing on the authoring machine saying so. Using a subpatch COPIES its
// definition into the project. This library is a palette to pick from, and it is read at most once
// per pick.

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StoredSubpatch {
  /** The definition as `SubpatchDef`, kept opaque here — main has no business parsing a graph. */
  def: unknown;
  name: string;
  savedAt: number;
}

function root(): string {
  return path.join(app.getPath('userData'), 'subpatches');
}

/** A file name we are willing to create — a name is not a path, and `../../autoexec` is a name too. */
export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 64);
  return cleaned || 'Untitled';
}

export function list(): StoredSubpatch[] {
  const dir = root();
  if (!fs.existsSync(dir)) return [];
  const out: StoredSubpatch[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as StoredSubpatch;
      if (raw?.def) out.push({ def: raw.def, name: raw.name || f.replace(/\.json$/, ''), savedAt: raw.savedAt ?? 0 });
    } catch (err) {
      // ONE BAD FILE MUST NOT EMPTY THE LIBRARY — the same rule the effect library follows, and for
      // the same reason: a browser showing nothing reads as "my work is gone".
      console.warn('[shader] skipping unreadable subpatch', f, (err as Error).message);
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function save(input: { name: string; def: unknown }): { ok: boolean; name: string; error?: string } {
  try {
    const name = safeName(input.name);
    fs.mkdirSync(root(), { recursive: true });
    fs.writeFileSync(
      path.join(root(), `${name}.json`),
      JSON.stringify({ name, def: input.def, savedAt: Date.now() }, null, 2),
      'utf8',
    );
    return { ok: true, name };
  } catch (e) {
    return { ok: false, name: input.name, error: (e as Error).message };
  }
}

export function remove(name: string): { ok: boolean; error?: string } {
  try {
    const file = path.join(root(), `${safeName(name)}.json`);
    if (path.relative(root(), file).startsWith('..')) return { ok: false, error: 'outside the library' };
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
