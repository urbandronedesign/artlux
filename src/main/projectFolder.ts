import { dialog, type BrowserWindow } from 'electron';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { ProjectData, CollectResult, NewProjectFolder, AssetEntry, AssetType } from '../../shared/protocol';

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
  tracking: ['lblob'], // recorded LiDAR-blob takes
};

// Library asset type → assets/ sub-folder (category).
const TYPE_CATEGORY: Record<AssetType, string> = {
  video: 'video', image: 'images', model: 'models', take: 'tracking',
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

  // Timeline: video clip paths + the recorded tracking-take library (.lblob sidecars). Both placed
  // clips and unplaced bin takes carry collectable paths, so map them together.
  const tl = out.timeline as any;
  if (tl && (Array.isArray(tl.clips) || Array.isArray(tl.trackingTakes))) {
    const next = { ...tl };
    if (Array.isArray(tl.clips)) next.clips = tl.clips.map((c: any) => {
      let n = isFilePath(c?.path) ? { ...c, path: map(c.path) } : c;
      // Generalized content clips carry the collectable file on content.url (Image/Video sources).
      const cu = c?.content?.url;
      if ((c?.content?.type === 'VIDEO' || c?.content?.type === 'IMAGE') && isFilePath(cu)) n = { ...n, content: { ...n.content, url: map(cu) } };
      return n;
    });
    if (Array.isArray(tl.trackingTakes)) next.trackingTakes = tl.trackingTakes.map((r: any) => (isFilePath(r?.path) ? { ...r, path: map(r.path) } : r));
    out.timeline = next;
  }

  // Managed asset library: every entry's path (incl. unused entries).
  if (Array.isArray(out.assets)) {
    out.assets = out.assets.map((a: any) => (isFilePath(a?.path) ? { ...a, path: map(a.path) } : a));
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

// Copy one file into <root>/assets/<cat>/ and build an AssetEntry. Files already inside assets/
// are referenced in place (no copy). Returns null on failure.
function copyIntoAssets(root: string, src: string, type: AssetType, name?: string): AssetEntry | null {
  const cat = TYPE_CATEGORY[type];
  const destDir = join(root, 'assets', cat);
  mkdirSync(destDir, { recursive: true });
  try {
    let dest: string;
    if (isInside(destDir, src)) { dest = src; }
    else { const u = uniqueDest(destDir, src); dest = u.dest; if (!u.reused) copyFileSync(src, dest); }
    const size = statSync(dest).size;
    return { id: randomUUID(), name: name ?? basename(dest, extname(dest)), type, path: dest, size, addedAt: new Date().toISOString() };
  } catch (e) {
    console.error('[projectFolder] import copy failed', src, e);
    return null;
  }
}

// Pick media files of a category and copy them into the project's assets/ tree → AssetEntry[].
export async function importAssets(win: BrowserWindow | null, projectFile: string, type: AssetType): Promise<AssetEntry[]> {
  const cat = TYPE_CATEGORY[type];
  if (!cat) return [];
  const opts = {
    title: `Import ${type}`,
    properties: ['openFile' as const, 'multiSelections' as const],
    filters: [{ name: type, extensions: ASSET_CATEGORIES[cat] }],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths.length) return [];
  const root = dirname(projectFile);
  scaffold(root);
  const out: AssetEntry[] = [];
  for (const src of res.filePaths) { const e = copyIntoAssets(root, src, type); if (e) out.push(e); }
  return out;
}

// Copy a known file (e.g. a freshly-recorded take from userData) into the project's assets/ tree.
export function importAssetFile(projectFile: string, srcPath: string, type: AssetType, name?: string): AssetEntry | null {
  const root = dirname(projectFile);
  scaffold(root);
  return copyIntoAssets(root, srcPath, type, name);
}

// Copy every external asset into <root>/assets/<category>/ and remap references to point there.
// Returns remapped data with *absolute* paths (the renderer applies it, then a save relativizes).
function collectInto(root: string, data: ProjectData): CollectResult {
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

  // Ensure every collected media file has a library entry, so it shows in the Media tab. Clips and
  // surfaces can reference files that were never imported (e.g. dragged straight onto the timeline);
  // without this they play but stay invisible in the library. Takes live in trackingTakes, not here.
  const CAT_TYPE: Record<string, AssetType> = { video: 'video', images: 'image', models: 'model' };
  const norm = (p: string) => (p || '').replace(/\\/g, '/').toLowerCase();
  const have = new Set<string>((out.assets ?? []).map((a) => norm(a?.path)));
  const added: AssetEntry[] = [];
  for (const dest of new Set(remap.values())) {
    if (!isInside(assetsDir, dest)) continue;          // only in-project files belong in the library
    const cat = categoryFor(dest);
    const type = cat ? CAT_TYPE[cat] : undefined;
    if (!type) continue;                               // unknown type, or a tracking take → skip
    const key = norm(dest);
    if (have.has(key)) continue;
    have.add(key);
    try {
      added.push({ id: randomUUID(), name: basename(dest, extname(dest)), type, path: dest, size: statSync(dest).size, addedAt: new Date().toISOString() });
    } catch { /* file vanished between passes — skip */ }
  }
  if (added.length) out.assets = [...(out.assets ?? []), ...added];

  return { data: out, copied, skipped, missing };
}

// In-place: collect into the project's own folder (the destructive path — the renderer confirms first).
export function collectAssets(projectFile: string, data: ProjectData): CollectResult {
  return collectInto(dirname(projectFile), data);
}

// Non-destructive: pick a fresh folder and collect a self-contained copy there, leaving the current
// project + working directory untouched. Returns the CollectResult plus the copy's project-file path;
// null if the user cancels (or declines to overwrite an existing project in the chosen folder).
export async function collectAssetsToFolder(win: BrowserWindow | null, data: ProjectData): Promise<(CollectResult & { projectFile: string }) | null> {
  const opts = { title: 'Collect a Copy to Folder', buttonLabel: 'Collect Here', properties: ['openDirectory' as const, 'createDirectory' as const] };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths[0]) return null;
  const root = res.filePaths[0];
  const projectFile = join(root, PROJECT_FILENAME);
  if (existsSync(projectFile)) {
    const warn = { type: 'warning' as const, buttons: ['Cancel', 'Overwrite'], defaultId: 0, cancelId: 0, message: 'This folder already contains a project.', detail: `${projectFile} will be overwritten.` };
    const c = win ? await dialog.showMessageBox(win, warn) : await dialog.showMessageBox(warn);
    if (c.response !== 1) return null;
  }
  return { ...collectInto(root, data), projectFile };
}
