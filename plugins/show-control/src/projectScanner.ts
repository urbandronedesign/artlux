// Scan a folder for ArtLux projects — both loose `.artlux`/`.json` files and portable project folders
// (a subdirectory containing `project.artlux`). Returns the loadable project-file path for each. No
// dialog (that's the point — the playlist needs headless discovery). Main-process only (fs access).

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import type { ProjectInfo } from './types';

const PROJECT_FILENAME = 'project.artlux';
const FILE_EXTS = new Set(['.artlux', '.json']);

// Scan one directory level. Portable folders take precedence: if a subfolder holds project.artlux we
// list that folder (isFolder=true) and don't also list the inner file loosely.
export function scanProjects(folder: string): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  let entries: string[];
  try { entries = readdirSync(folder); }
  catch (e) { console.error('[show-control] scan failed', folder, e); return out; }

  for (const name of entries) {
    const full = join(folder, name);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }

    if (st.isDirectory()) {
      const pf = join(full, PROJECT_FILENAME);
      if (existsSync(pf)) out.push({ path: pf, name, isFolder: true });
      continue;
    }
    if (st.isFile() && FILE_EXTS.has(extname(name).toLowerCase())) {
      // Skip a bare project.artlux found loose at the top level (it belongs to a folder scanned above).
      if (name === PROJECT_FILENAME) continue;
      out.push({ path: full, name: basename(name, extname(name)), isFolder: false });
    }
  }
  // Stable, human-friendly order.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
