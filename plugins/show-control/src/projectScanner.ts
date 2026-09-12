// Find the ArtLux projects on this machine — loose `.artlux`/`.json` files and portable project
// folders (a subdirectory containing `project.artlux`) — by walking a folder AND ITS SUBFOLDERS.
// No dialog (that's the point — the playlist needs headless discovery, and the tablet has no file
// picker at all). Main-process only (fs access).
//
// RECURSION is the default and not an option, because the one-level scan this replaced could not see
// the way a venue actually files its shows: `D:\Shows\Museum\Hall A\hall-a.artlux`. Pointing at
// `D:\Shows` returned nothing, and the tablet's only recourse was retyping a deeper path on a touch
// keyboard. The walk is bounded on all four axes that can make a recursive scan on a show machine
// hurt — depth, count, the folders that are never projects, and symlink loops.

import { readdirSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { ProjectInfo, ScanResult } from './types';

const PROJECT_FILENAME = 'project.artlux';
const FILE_EXTS = new Set(['.artlux', '.json']);

export const DEFAULT_MAX_DEPTH = 6;
export const DEFAULT_LIMIT = 500;

// Directories that are never a project and can be enormous. `assets` is the ArtLux portable-project
// media directory: we already stop at a folder that holds project.artlux, but a media tree parked
// beside the projects would otherwise be walked for nothing.
const SKIP_DIRS = new Set([
  'node_modules', 'assets', '.git', '$recycle.bin', 'system volume information',
  'windows', 'program files', 'program files (x86)', 'appdata', '__pycache__',
]);

export interface ScanOptions {
  maxDepth?: number; // how many levels below `folder` to descend (0 = the folder itself only)
  limit?: number;    // stop after this many projects (reported as `truncated`)
}

export function scanProjects(folder: string, opts: ScanOptions = {}): ScanResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const out: ProjectInfo[] = [];
  // Two different "we did not show you everything": the COUNT cap aborts the whole walk, the DEPTH
  // cap only stops descending one branch and the walk carries on into its siblings. Conflating them
  // was a bug the moment it was written — one deep branch would have ended the scan and hidden every
  // project after it.
  let hitLimit = false;
  let hitDepth = false;

  if (!folder) return { root: '', projects: out, truncated: false };

  // `rel` is the sub-path BELOW the scan root, '' at the root itself. It is what the UI shows next to
  // a project name, and the only thing that tells four shows all called "Main" apart.
  const walk = (dir: string, rel: string, depth: number): void => {
    if (hitLimit) return;
    let entries: string[];
    try { entries = readdirSync(dir); }
    catch (e) {
      // An unreadable subfolder (permissions, a disconnected network share) must not abort the walk —
      // the other 40 projects are still findable. Only a failure at the ROOT is worth a log line.
      if (!rel) console.error('[show-control] scan failed', dir, e);
      return;
    }

    const subdirs: { full: string; name: string }[] = [];

    for (const name of entries) {
      if (out.length >= limit) { hitLimit = true; return; }
      const full = join(dir, name);

      // lstat, not stat: a symlinked directory is skipped outright rather than followed, which is the
      // cheap and complete answer to a cyclic tree (a junction pointing at its own ancestor walks
      // forever, and a show machine's Documents folder is full of them).
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) continue;

      if (st.isDirectory()) {
        // A portable project: list the FOLDER and do not descend (its innards are assets, and its
        // project.artlux must not also appear loosely).
        if (existsSync(join(full, PROJECT_FILENAME))) {
          out.push({ path: join(full, PROJECT_FILENAME), name, isFolder: true, rel });
          continue;
        }
        if (SKIP_DIRS.has(name.toLowerCase()) || name.startsWith('.')) continue;
        subdirs.push({ full, name });
        continue;
      }

      if (st.isFile() && FILE_EXTS.has(extname(name).toLowerCase())) {
        // A bare project.artlux loose at this level belongs to the folder handled above.
        if (name === PROJECT_FILENAME) continue;
        out.push({ path: full, name: basename(name, extname(name)), isFolder: false, rel });
      }
    }

    // Breadth-ish: this level's files are all recorded before descending, so a shallow project never
    // loses its place in the list to a deep one, and a truncated scan keeps the nearest results.
    if (depth >= maxDepth) {
      // SAY SO. Stopping at the depth cap with folders still unopened hides projects exactly the way
      // the count cap does, and an unreported cap reads as "that project is not there" — the one
      // answer a project picker must never give by accident.
      if (subdirs.length) hitDepth = true;
      return;
    }
    for (const sd of subdirs) {
      if (hitLimit) return;
      walk(sd.full, rel ? rel + '/' + sd.name : sd.name, depth + 1);
    }
  };

  // The scan root itself may BE a portable project — pointing the folder field at one and getting
  // "no projects found" is a needless dead end.
  try {
    if (statSync(folder).isDirectory() && existsSync(join(folder, PROJECT_FILENAME))) {
      return {
        root: folder,
        projects: [{ path: join(folder, PROJECT_FILENAME), name: basename(folder), isFolder: true, rel: '' }],
        truncated: false,
      };
    }
  } catch { /* fall through to the walk, which reports its own root failure */ }

  walk(folder, '', 0);

  // Stable, human-friendly order: shallowest first, then by name within a subfolder.
  out.sort((a, b) => (a.rel === b.rel ? a.name.localeCompare(b.name) : a.rel.localeCompare(b.rel)));
  return { root: folder, projects: out, truncated: hitLimit || hitDepth };
}
