// PERSISTED THUMBNAILS — decode a frame once, not once per session.
//
// Filmstrips and library tiles are decoded on the same hardware the show uses, and none of that work
// survived closing the app: reopening a project re-decoded every visible tile from scratch. The bytes
// behind each one are tiny (a 160x90 WebP is a couple of kB) and the source they came from cannot
// change without changing its mtime or size, so there is no reason to pay twice.
//
// KEYED LIKE THE AUDIO CONFORM CACHE — path + mtime + size — deliberately, so this repo has ONE idiom
// for "a derived artefact of a source file". Re-encode a clip in place and its key changes, so a stale
// thumbnail cannot outlive the frame it depicts.
//
// WHERE IT LIVES: `<projectFolder>/.artlux-cache/thumbs/`. Dot-prefixed so scanAssets ignores it (it
// would otherwise adopt thumbnails as library media), and inside the project rather than in userData
// so that copying a project folder to a venue machine carries its thumbnails with it — the first open
// on show day is the one that must not be spent decoding. Falls back to userData when the project has
// no folder (an unsaved document), which is the same trade the conform cache makes.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app } from 'electron';

let root: string | null = null;   // the open project's cache dir, or null → userData

export function setProject(projectFile: string | null): void {
  const base = projectFile ? join(dirname(projectFile), '.artlux-cache') : join(app.getPath('userData'), 'thumb-cache');
  root = join(base, 'thumbs');
  try { mkdirSync(root, { recursive: true }); } catch { root = null; } // read-only volume: degrade to no cache
}

// path + mtime + size → a short stable name. Identical shape to the audio conform cache's key.
function keyFor(src: string, qt: number): string | null {
  try {
    const st = statSync(src);
    return createHash('sha1').update(`${src} ${st.mtimeMs} ${st.size} ${qt}`).digest('hex').slice(0, 24);
  } catch {
    return null; // the source is gone — nothing to key, and nothing worth caching
  }
}

const fileFor = (key: string): string | null => (root ? join(root, `${key}.webp`) : null);

/** A previously-encoded thumbnail for (src, quantized time), or null. */
export async function get(src: string, qt: number): Promise<Uint8Array | null> {
  const key = keyFor(src, qt);
  const f = key && fileFor(key);
  if (!f || !existsSync(f)) return null;
  try { return new Uint8Array(await readFile(f)); } catch { return null; }
}

/** Store an encoded thumbnail. Best-effort: a failure here costs a re-decode, never correctness. */
export async function put(src: string, qt: number, bytes: Uint8Array): Promise<void> {
  const key = keyFor(src, qt);
  const f = key && fileFor(key);
  if (!f) return;
  try { await writeFile(f, bytes); } catch { /* full disk / read-only: the cache is an optimisation */ }
}

/** Drop the whole cache for the open project — the operator-facing "it's safe to delete" button. */
export async function clear(): Promise<void> {
  if (!root) return;
  try { await rm(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true }); } catch { /* best effort */ }
}
