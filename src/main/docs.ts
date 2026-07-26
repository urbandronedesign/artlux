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
const REFERENCE = 'docs';                            // the top-level reference pages (NOT recursive)
const REFERENCE_ID = 'docs';

// ── THE REFERENCE SECTION, AND WHY IT IS A CURATED LIST RATHER THAN A readdir ─────────────────────────
// The reference pages were UNREACHABLE from inside the app. The browser's roots were `examples/` and
// `docs/user-guide/` only — so every `../../docs/STATE-MACHINE.md` link in every tutorial resolved to
// nothing, and DocsBrowser's handler (`if (match) load(match)` — with no else) SILENTLY SWALLOWED the
// click. Nineteen distinct targets across the three example sets, every one a dead link, and no error to
// tell you so. A venue tech with no internet had no way to read the reference at all.
//
// It is an explicit list, not a directory scan, because `docs/` also holds this project's INTERNAL notes —
// PROGRESS, ROADMAP, ARCHITECTURE_PLAN, UI-UX-AUDIT, the optimisation write-ups. Those are for whoever is
// building ArtLux, not for whoever is running a show with it, and dumping thirty-five files into an
// operator's sidebar would bury the twenty that matter.
//
// ⚠ THE LIST CURATES THE **NAV**, NOT THE **ACCESS**. readDoc() below admits ANY `docs/*.md`, so a link to
// an unlisted page still opens — it simply does not clutter the tree. Curation must never become a broken
// link; that is the bug this whole section exists to fix.
const REFERENCE_PAGES = [
  'FEATURES.md', 'AUDIO.md', 'TIMELINE.md', 'SCENES.md', 'SCENE-TIMELINES.md', 'STATE-MACHINE.md',
  'SHOW-CONTROL.md', 'SURFACES.md', 'EFFECTS.md', 'ASSETS.md', 'CODECS.md', 'OUTPUTS.md',
  'FIXTURE-LIBRARY.md', 'LIGHTING-SHOW.md', 'LEDMAP.md',
  'CALIBRATION.md', 'AUTO-ALIGN.md', 'NVWARP.md', 'OSC.md', 'NDI.md', 'SPOUT.md', 'AUGMENTA.md',
  'MEDIAPIPE.md', 'TRACKING_TAKES.md', 'TRACKING_SYNC.md', 'MONITORING.md', 'WATCHDOG.md', 'WORKSPACE.md',
  'PLUGINS.md', 'SDK.md', 'ARCHITECTURE.md', 'DEVELOPMENT.md',
];

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

  // Finally the REFERENCE pages — last, because they are what you reach for once the guide and the
  // tutorials have stopped answering the question. In the CURATED order (see REFERENCE_PAGES), not
  // alphabetical: the order is the reading order, and `Audio` sitting under `Architecture` would be an
  // accident of the alphabet rather than a decision.
  const refDir = join(root, REFERENCE);
  if (existsSync(refDir)) {
    const present = new Set(await mdFiles(refDir));   // readdir is NOT recursive ⇒ user-guide/ is untouched
    const entries: DocEntry[] = [];
    for (const f of REFERENCE_PAGES) {
      if (!present.has(f)) continue;                  // a curated page that has been renamed simply drops out
      entries.push({ id: `${REFERENCE_ID}/${f}`, title: await titleOf(join(refDir, f), pretty(f)) });
    }
    if (entries.length) sections.push({ id: 'reference', title: 'Reference', entries });
  }

  return sections;
}

// Read one doc by tree id. The id is a POSIX-relative path under examples/ or docs/; resolve + validate
// it stays inside those subtrees (no traversal), then return the markdown and its absolute directory (so
// the renderer can resolve sibling images / .artlux links).
//
// ⚠ THE ADMITTED SET IS DELIBERATELY WIDER THAN THE NAV. `docs` covers the reference pages AND
// `docs/user-guide/` beneath it, and it admits every `docs/*.md` — including the ones REFERENCE_PAGES
// leaves out of the sidebar. That is the point: a tutorial linking to a page nobody chose to list must
// still open it. Curating a NAV is a judgement about clutter; curating ACCESS would just be a broken link
// with extra steps, which is exactly the bug this root was added to fix.
export async function readDoc(id: string): Promise<DocContent | null> {
  if (!id || !id.toLowerCase().endsWith('.md')) return null;
  const root = docsRoot();
  const abs = normalize(join(root, id));
  const okRoots = [join(root, EXAMPLES), join(root, REFERENCE)];   // REFERENCE ⊃ USER_GUIDE
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
  const okRoots = [join(root, EXAMPLES), join(root, REFERENCE)];   // REFERENCE ⊃ USER_GUIDE — same set readDoc admits
  if (!okRoots.some((r) => abs === r || abs.startsWith(r + sep))) return null;
  try {
    return { mime, data: new Uint8Array(await readFile(abs)) };
  } catch { return null; }
}
