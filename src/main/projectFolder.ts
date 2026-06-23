import { dialog, type BrowserWindow } from 'electron';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { ProjectData, CollectResult, NewProjectFolder } from '../../shared/protocol';

// Portable-project support: a project is a *folder* containing `project.artlux` plus
// an `assets/{video,models,images}/` tree. Asset paths are stored relative to the
// project folder (the file's directory) when they live inside it, and resolved back to
// absolute on load — so the renderer always works with absolute paths. "Collect Assets"
// copies external assets into the tree and rewrites references to point inside it.

export const PROJECT_FILENAME = 'project.artlux';

const ASSET_CATEGORIES: Record<string, string[]> = {
  video: ['mp4', 'webm', 'mov', 'mkv'],
  models: ['glb', 'gltf'],
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
};

function categoryFor(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase();
  for (const [cat, exts] of Object.entries(ASSET_CATEGORIES)) if (exts.includes(ext)) return cat;
  return null;
}

// A non-file-path content url (blob/http/data) is never a collectable asset.
const isFilePath = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && !/^(blob:|https?:|data:)/i.test(s);

// ---- The single source of truth for where asset paths live in a project ----------
// Visits every asset path string, replacing it with map(value) (return the same string
// to leave it unchanged). Mutates a shallow-cloned copy so the input isn't touched.
function mapAssetPaths(data: ProjectData, map: (path: string) => string): ProjectData {
  const out: ProjectData = { ...data };

  // Surfaces: VIDEO/IMAGE content.url (skip blob:/http: live urls).
  if (Array.isArray(out.surfaces)) {
    out.surfaces = out.surfaces.map((s: any) => {
      const c = s?.content;
      if (c && (c.type === 'VIDEO' || c.type === 'IMAGE') && isFilePath(c.url)) {
        return { ...s, content: { ...c, url: map(c.url) } };
      }
      return s;
    });
  }

  // 3D scene: mesh model paths (planes have path '' → skipped by the empty check).
  if (out.scene3D && Array.isArray(out.scene3D.models)) {
    out.scene3D = {
      ...out.scene3D,
      models: out.scene3D.models.map((m: any) =>
        isFilePath(m?.path) ? { ...m, path: map(m.path) } : m),
    };
  }

  // Timeline: video clip paths.
  const tl = out.timeline as any;
  if (tl && Array.isArray(tl.clips)) {
    out.timeline = { ...tl, clips: tl.clips.map((c: any) => (isFilePath(c?.path) ? { ...c, path: map(c.path) } : c)) };
  }

  return out;
}

const toPosix = (p: string) => p.split(sep).join('/');

// Within `root`? (and not escaping via ..)
function isInside(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

// On save: paths under the project folder → folder-relative (POSIX); others kept as-is.
export function relativizeAssets(data: ProjectData, root: string): ProjectData {
  return mapAssetPaths(data, (p) => (isAbsolute(p) && isInside(root, p) ? toPosix(relative(root, p)) : p));
}

// On load: relative paths → absolute against the project folder; absolute kept as-is.
export function resolveAssets(data: ProjectData, root: string): ProjectData {
  return mapAssetPaths(data, (p) => (isAbsolute(p) ? p : join(root, p)));
}

function scaffold(root: string): void {
  for (const cat of Object.keys(ASSET_CATEGORIES)) mkdirSync(join(root, 'assets', cat), { recursive: true });
}

export async function newProjectFolder(win: BrowserWindow | null): Promise<NewProjectFolder | null> {
  const opts = {
    title: 'New Project Folder',
    buttonLabel: 'Create Project',
    properties: ['openDirectory' as const, 'createDirectory' as const],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const root = res.filePaths[0];
  scaffold(root);
  return { root, projectFile: join(root, PROJECT_FILENAME) };
}

// Pick a project folder and return the path to its project file (the caller loads it via
// persistence, which resolves relative asset paths and records the recent file).
export async function pickProjectFolder(win: BrowserWindow | null): Promise<string | null> {
  const opts = { title: 'Open Project Folder', properties: ['openDirectory' as const] };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const projectFile = join(res.filePaths[0], PROJECT_FILENAME);
  if (!existsSync(projectFile)) {
    const msg = {
      type: 'error' as const,
      message: 'No project found in this folder',
      detail: `Expected ${PROJECT_FILENAME} inside the selected folder.`,
    };
    if (win) await dialog.showMessageBox(win, msg); else await dialog.showMessageBox(msg);
    return null;
  }
  return projectFile;
}

// Pick a unique destination filename inside destDir, reusing an existing identically-sized file.
function uniqueDest(destDir: string, srcPath: string): { dest: string; reused: boolean } {
  const ext = extname(srcPath);
  const stem = basename(srcPath, ext);
  const srcSize = statSync(srcPath).size;
  let candidate = join(destDir, stem + ext);
  let n = 0;
  while (existsSync(candidate)) {
    if (statSync(candidate).size === srcSize) return { dest: candidate, reused: true };
    n += 1;
    candidate = join(destDir, `${stem}-${n}${ext}`);
  }
  return { dest: candidate, reused: false };
}

// Copy every external asset into <root>/assets/<category>/ and remap references to point there.
// Returns remapped data with *absolute* paths (the renderer applies it, then a save relativizes).
export function collectAssets(projectFile: string, data: ProjectData): CollectResult {
  const root = dirname(projectFile);
  scaffold(root);
  const assetsDir = join(root, 'assets');

  const remap = new Map<string, string>(); // source path -> collected absolute path
  const missing: string[] = [];
  let copied = 0;
  let skipped = 0;

  // First pass: discover unique source paths and copy them in.
  mapAssetPaths(data, (p) => {
    if (remap.has(p)) return p; // already handled this source
    const abs = isAbsolute(p) ? p : join(root, p);
    // Already inside assets/ → nothing to do.
    if (isInside(assetsDir, abs)) { remap.set(p, abs); skipped += 1; return p; }
    const cat = categoryFor(abs);
    if (!cat) { skipped += 1; return p; }            // unknown type — leave external
    if (!existsSync(abs)) { missing.push(abs); skipped += 1; return p; }
    try {
      const { dest, reused } = uniqueDest(join(assetsDir, cat), abs);
      if (!reused) { copyFileSync(abs, dest); copied += 1; }
      remap.set(p, dest);
    } catch (e) {
      console.error('[projectFolder] copy failed', abs, e);
      skipped += 1;
    }
    return p;
  });

  // Second pass: rewrite references to the collected copies.
  const out = mapAssetPaths(data, (p) => remap.get(p) ?? p);
  return { data: out, copied, skipped, missing };
}
