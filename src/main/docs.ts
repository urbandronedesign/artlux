import { app } from 'electron';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, sep, normalize, extname } from 'node:path';
import type { DocSection, DocEntry, DocContent, DocAsset } from '../../shared/protocol';

// Main-side backend for the in-app Docs Browser. Enumerates the shipped example/tutorial sets
// (examples/<set>/README.md + tuto/*.md) and the illustrated user guide (docs/user-guide/*.md) into a
// two-level tree, and reads one doc's markdown by tree id. The sandboxed renderer has no fs, so all
// path resolution lives here; ids are POSIX-relative and validated against the allowed subtrees.

// Where the shipped docs/examples live on disk. In dev that is the repo working tree
// (app.getAppPath()); in a packaged build they are copied under process.resourcesPath via
// electron-builder extraResources. Mirrors the dev/packaged fork used by the watchdog.
function docsRoot(): string {
  return app.isPackaged ? (process.resourcesPath || app.getAppPath()) : app.getAppPath();
}

const EXAMPLES = 'examples';
const USER_GUIDE = join('docs', 'user-guide');       // OS-separated for fs joins
const USER_GUIDE_ID = 'docs/user-guide';             // POSIX for tree ids

// First markdown H1 as a human title, else a prettified filename.
async function titleOf(abs: string, fallback: string): Promise<string> {
  try {
    const txt = await readFile(abs, 'utf8');
    const m = txt.match(/^\s*#\s+(.+?)\s*$/m);
    if (m) return m[1].replace(/[`*_]/g, '').trim();
  } catch { /* fall through to fallback */ }
  return fallback;
}

function pretty(name: string): string {
  return name.replace(/\.md$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

async function mdFiles(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.md')).sort(); }
  catch { return []; }
}

// Build the tree: the user guide first (its first page is what the browser opens by default), then one
// section per example set (Overview + tutorial chapters).
export async function listDocs(): Promise<DocSection[]> {
  const root = docsRoot();
  const sections: DocSection[] = [];

  // User guide first: README first, then the numbered pages; skip PLAN.md and the images/ folder.
  const ugDir = join(root, USER_GUIDE);
  if (existsSync(ugDir)) {
    const ordered = (await mdFiles(ugDir))
      .filter((f) => f.toLowerCase() !== 'plan.md')
      .sort((a, b) => (a.toLowerCase() === 'readme.md' ? -1 : b.toLowerCase() === 'readme.md' ? 1 : a.localeCompare(b)));
    const entries: DocEntry[] = [];
    for (const f of ordered) entries.push({ id: `${USER_GUIDE_ID}/${f}`, title: await titleOf(join(ugDir, f), pretty(f)) });
    if (entries.length) sections.push({ id: 'user-guide', title: 'User guide', entries });
  }

  // Then one section per example set (Overview + tutorial chapters).
  const exDir = join(root, EXAMPLES);
  if (existsSync(exDir)) {
    let sets: string[] = [];
    try { sets = (await readdir(exDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); }
    catch { /* no examples */ }
    for (const set of sets) {
      const setDir = join(exDir, set);
      const entries: DocEntry[] = [];
      const readme = join(setDir, 'README.md');
      if (existsSync(readme)) entries.push({ id: `${EXAMPLES}/${set}/README.md`, title: 'Overview' });
      const tutoDir = join(setDir, 'tuto');
      if (existsSync(tutoDir)) {
        const tutoFiles = (await mdFiles(tutoDir)).sort((a, b) =>
          a.toLowerCase() === 'readme.md' ? -1 : b.toLowerCase() === 'readme.md' ? 1 : a.localeCompare(b));
        for (const f of tutoFiles) {
          const isIndex = f.toLowerCase() === 'readme.md';
          entries.push({
            id: `${EXAMPLES}/${set}/tuto/${f}`,
            title: isIndex ? 'Tutorial — overview' : await titleOf(join(tutoDir, f), pretty(f)),
          });
        }
      }
      if (entries.length) sections.push({ id: `ex:${set}`, title: await titleOf(readme, pretty(set)), entries });
    }
  }

  return sections;
}

// Read one doc by tree id. The id is a POSIX-relative path under examples/ or docs/user-guide/;
// resolve + validate it stays inside those subtrees (no traversal), then return the markdown and its
// absolute directory (so the renderer can resolve sibling images / .artlux links).
export async function readDoc(id: string): Promise<DocContent | null> {
  if (!id || !id.toLowerCase().endsWith('.md')) return null;
  const root = docsRoot();
  const abs = normalize(join(root, id));
  const okRoots = [join(root, EXAMPLES), join(root, USER_GUIDE)];
  if (!okRoots.some((r) => abs === r || abs.startsWith(r + sep))) return null;
  try {
    const markdown = await readFile(abs, 'utf8');
    return { markdown, dir: abs.slice(0, abs.lastIndexOf(sep)) };
  } catch { return null; }
}

// Images only — the docs pane never loads other file kinds as assets.
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

// Read a sibling image a doc references (e.g. user-guide `images/*.png`). The renderer resolves the
// relative markdown src against the doc's `dir` and passes the absolute path here; we re-validate it
// stays inside the docs subtrees (same guard as readDoc) and is an image, then return bytes + MIME.
export async function readDocAsset(absPath: string): Promise<DocAsset | null> {
  if (!absPath) return null;
  const mime = IMAGE_MIME[extname(absPath).toLowerCase()];
  if (!mime) return null;
  const root = docsRoot();
  const abs = normalize(absPath);
  const okRoots = [join(root, EXAMPLES), join(root, USER_GUIDE)];
  if (!okRoots.some((r) => abs === r || abs.startsWith(r + sep))) return null;
  try {
    return { mime, data: new Uint8Array(await readFile(abs)) };
  } catch { return null; }
}
