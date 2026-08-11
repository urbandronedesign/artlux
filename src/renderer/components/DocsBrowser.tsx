import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, ChevronDown, ChevronRight, FileText, ExternalLink, Search, CornerDownLeft } from 'lucide-react';
import { marked } from 'marked';
import type { DocSection, DocEntry, DocChunk } from '../../../shared/protocol';
import { useResizable } from '../hooks/useResizable';
import { loadDocIndex, searchDocs } from '../services/docSearch';

// Right-side dockable Docs Browser. Lists the shipped example/tutorial sets + the user guide (from the
// main-side docs.ts index) and renders one page's markdown. Links are delegated: external → browser,
// `../*.artlux` → load that example into the app (onOpenExample), relative `*.md` → navigate in-tree.
// Content is first-party (repo markdown), so it is rendered via marked without extra sanitization.

interface Props {
  onClose: () => void;
  width?: number;
  onResize?: (w: number) => void;
  /** Load an example project by absolute path (wired to the app's open-by-path flow). */
  onOpenExample?: (absPath: string) => void;
  /** 'dock' = right-side column (resize handle + detach/close); 'window' = fills a standalone window. */
  mode?: 'dock' | 'window';
  /** In window mode, open straight to this doc id. */
  initialId?: string;
}

marked.setOptions({ gfm: true, breaks: false });

// Renderer has no node `path`; resolve "dir" + a relative link into a POSIX absolute path.
function resolveRel(dir: string, rel: string): string {
  const parts = (dir.replace(/\\/g, '/') + '/' + rel).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop(); else out.push(p);
  }
  return out.join('/');
}

export const DocsBrowser: React.FC<Props> = ({ onClose, width = 480, onResize, onOpenExample, mode = 'dock', initialId }) => {
  const [tree, setTree] = useState<DocSection[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState<string>('');
  const [dir, setDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  const onResizeDown = useResizable({ axis: 'x', invert: true, value: width, min: 360, max: 900, onChange: onResize ?? (() => {}) });

  // ── SEARCH ──────────────────────────────────────────────────────────────────────────────────────
  // This panel was a tree with no search at all — and it is the documentation surface a venue tech can
  // actually reach, offline, at night. Ctrl+F searched the open page only, so answering "where is
  // blade explained" meant guessing which of 66 pages to open. The index is heading-sized slices built
  // in main (see docs.ts) and ranked by the SAME scorer the F1 help modal uses (services/docSearch).
  const [q, setQ] = useState('');
  const [chunks, setChunks] = useState<DocChunk[]>([]);
  useEffect(() => { let alive = true; loadDocIndex().then((c) => { if (alive) setChunks(c); }); return () => { alive = false; }; }, []);
  const hits = useMemo(() => searchDocs(chunks, q, 60), [chunks, q]);

  // A heading to scroll to once the next page has rendered. Set when a search result or a deep link
  // names one; consumed by the effect below. A ref, not state: it must not trigger a render of its own.
  const pendingHeading = useRef<string | null>(null);

  const load = (e: DocEntry, heading?: string) => {
    setSelected(e.id);
    setLoading(true);
    pendingHeading.current = heading ?? null;
    window.artlux.docsRead(e.id).then((doc) => {
      setLoading(false);
      if (!doc) { setHtml('<p>Could not load this document.</p>'); setDir(''); return; }
      setHtml(marked.parse(doc.markdown) as string);
      setDir(doc.dir);
      paneRef.current?.scrollTo(0, 0);
    });
  };

  // Jump to the heading a search result named. Matched by TEXT, not by a generated id: `marked` does
  // not emit heading ids here, and inventing a slug on both sides would give two slug functions to keep
  // in agreement — the exact class of drift this whole documentation effort is about. The heading text
  // is already in the chunk, so compare that.
  useEffect(() => {
    const want = pendingHeading.current;
    if (!want || !html) return;
    pendingHeading.current = null;
    const pane = paneRef.current;
    if (!pane) return;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const target = [...pane.querySelectorAll('h1, h2, h3, h4')]
      .find((el) => norm(el.textContent || '') === norm(want));
    target?.scrollIntoView({ block: 'start' });
  }, [html]);

  useEffect(() => {
    let alive = true;
    window.artlux.docsList().then((t) => {
      if (!alive) return;
      const list = t ?? [];
      setTree(list);
      const all = list.flatMap((s) => s.entries.map((e) => ({ sec: s.id, e })));
      // `initialId` may carry an anchor — "docs/user-guide/06-timeline.md#Blade tool" — because the F1
      // help modal deep-links a SEARCH RESULT here, and a result is a heading, not a page.
      const [wantId, wantHeading] = (initialId ?? '').split('#');
      const target = (wantId && all.find((x) => x.e.id === wantId)) || (list[0]?.entries[0] ? { sec: list[0].id, e: list[0].entries[0] } : null);
      if (target) { setOpen(new Set([target.sec])); load(target.e, wantHeading || undefined); }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After each doc renders, resolve its relative <img> sources (e.g. user-guide `images/*.png`) to
  // blob URLs: the sandboxed renderer can't load `file://` disk paths, so main reads the bytes (path
  // validated under the docs roots) and we wrap them in an object URL. Object URLs are revoked when the
  // page changes or the panel unmounts. Absolute/data/blob srcs are left untouched.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !dir) return;
    let cancelled = false;
    const created: string[] = [];
    pane.querySelectorAll('img').forEach((img) => {
      const raw = img.getAttribute('src') || '';
      if (!raw || /^(https?:|data:|blob:)/i.test(raw)) return;
      const abs = resolveRel(dir, raw.split('#')[0].split('?')[0]);
      window.artlux.docsReadAsset(abs).then((asset) => {
        if (cancelled) return;
        if (!asset) {
          const span = document.createElement('span');
          span.className = 'docs-img-missing';
          span.textContent = (img.getAttribute('alt') || 'image') + ' — not found';
          img.replaceWith(span);
          return;
        }
        const url = URL.createObjectURL(new Blob([asset.data], { type: asset.mime }));
        created.push(url);
        img.src = url;
      });
    });
    return () => {
      cancelled = true;
      for (const u of created) URL.revokeObjectURL(u);
    };
  }, [html, dir]);

  const onPaneClick = (ev: React.MouseEvent) => {
    const a = (ev.target as HTMLElement).closest('a');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (!href) return;
    if (href.startsWith('#')) {
      // AN IN-PAGE LINK, MATCHED BY TEXT — the same rule as the search-result jump above, and for the
      // same reason: a slug function here and another in whatever wrote the markdown is two things to
      // keep in agreement. A link's own text is its heading's text ("Jump to: Input" → "## Input"), so
      // there is nothing to invent. Without this, clicking one does nothing at all: the PANE scrolls,
      // not the document, so the browser's own fragment handling has nothing to move.
      const want = (a.textContent || '').trim().toLowerCase();
      const target = [...(paneRef.current?.querySelectorAll('h1, h2, h3, h4') ?? [])]
        .find((h) => (h.textContent || '').trim().toLowerCase() === want);
      if (target) { ev.preventDefault(); target.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      return;
    }
    ev.preventDefault();
    if (/^https?:/i.test(href)) { window.artlux.openExternal(href); return; }
    const clean = href.split('#')[0].split('?')[0];
    if (!clean || !dir) return;
    const abs = resolveRel(dir, clean);
    if (/\.artlux$/i.test(clean)) { onOpenExample?.(abs); return; }
    if (/\.md$/i.test(clean)) {
      const posix = abs.replace(/\\/g, '/');
      const match = tree.flatMap((s) => s.entries).find((e) => posix.endsWith('/' + e.id) || posix.endsWith(e.id));
      if (match) load(match);
    }
  };

  return (
    <div className="relative h-full flex flex-col bg-surface-1 text-fg-1">
      <style>{DOCS_CSS}</style>
      {/* Left-edge resize handle (dock mode only; the standalone window resizes itself) */}
      {mode === 'dock' && (
        <div onPointerDown={onResizeDown} title="Resize" className="absolute left-0 top-0 h-full w-1.5 -ml-0.5 cursor-col-resize hover:bg-accent/30 z-10" />
      )}

      {/* Header */}
      <div className="h-10 shrink-0 flex items-center justify-between gap-2 px-3 border-b border-line-1 bg-surface-2">
        <span className="text-xs font-semibold uppercase tracking-wider">Docs &amp; Tutorials</span>
        {mode === 'dock' && (
          <div className="flex items-center gap-2">
            <button onClick={() => { window.artlux.openDocsWindow(selected ?? undefined); onClose(); }} aria-label="Open in a separate window" title="Detach to a window" className="text-fg-2 hover:text-fg-1"><ExternalLink size={15} /></button>
            <button onClick={onClose} aria-label="Close docs" title="Close" className="text-fg-2 hover:text-fg-1"><X size={16} /></button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Tree — or, while searching, the results that replace it */}
        <nav className="w-52 shrink-0 overflow-y-auto border-r border-line-1 py-1.5 text-xs">
          {/* Search box. Sticky, because the results below it can be long and losing the field you are
              typing in when you scroll is the small indignity that makes people stop using search. */}
          <div className="sticky top-0 z-10 bg-surface-1 px-2 pb-1.5">
            <div className="flex items-center gap-1.5 px-2 h-7 rounded bg-surface-2 border border-line-1 focus-within:border-accent/60">
              <Search size={12} className="text-fg-3 shrink-0" />
              <input
                value={q}
                onChange={(ev) => setQ(ev.target.value)}
                onKeyDown={(ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); setQ(''); } }}
                placeholder="Search the docs…"
                aria-label="Search the documentation"
                className="flex-1 min-w-0 bg-transparent outline-none text-xs text-fg-1 placeholder:text-fg-3"
              />
              {q && (
                <button onClick={() => setQ('')} title="Clear" aria-label="Clear search" className="text-fg-3 hover:text-fg-1 shrink-0">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {q ? (
            <div className="pt-0.5">
              <div className="px-3 py-1 text-micro uppercase tracking-wider text-fg-3">
                {hits.length === 0 ? 'No match' : `${hits.length} result${hits.length === 1 ? '' : 's'}`}
              </div>
              {hits.map((h) => {
                const entry = tree.flatMap((s) => s.entries).find((e) => e.id === h.chunk.docId);
                return (
                  <button
                    key={h.chunk.id}
                    onClick={() => { if (entry) load(entry, h.chunk.heading || undefined); }}
                    title={`${h.chunk.doc}${h.chunk.heading ? ' ▸ ' + h.chunk.heading : ''}`}
                    className="w-full flex flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-surface-2 text-fg-2 hover:text-fg-1"
                  >
                    <span className="flex items-center gap-1 w-full">
                      <CornerDownLeft size={10} className="shrink-0 opacity-50" />
                      <span className="truncate">{h.chunk.heading || h.chunk.doc}</span>
                    </span>
                    <span className="text-micro text-fg-3 truncate w-full">{h.chunk.doc}</span>
                    <span className="text-micro text-fg-3 line-clamp-2 leading-snug opacity-80">{h.excerpt}</span>
                  </button>
                );
              })}
            </div>
          ) : (
          <>
          {tree.length === 0 && <div className="px-3 py-2 text-fg-3 italic">No docs found.</div>}
          {tree.map((s) => {
            const isOpen = open.has(s.id);
            return (
              <div key={s.id}>
                <button
                  onClick={() => setOpen((o) => { const n = new Set(o); n.has(s.id) ? n.delete(s.id) : n.add(s.id); return n; })}
                  className="w-full flex items-center gap-1 px-2 py-1.5 text-left font-semibold text-fg-2 hover:text-fg-1 hover:bg-surface-2"
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="truncate">{s.title}</span>
                </button>
                {isOpen && s.entries.map((e) => (
                  <button
                    key={e.id}
                    onClick={() => load(e)}
                    title={e.title}
                    className={`w-full flex items-center gap-1.5 pl-6 pr-2 py-1 text-left truncate hover:bg-surface-2 ${selected === e.id ? 'text-accent bg-surface-2' : 'text-fg-2 hover:text-fg-1'}`}
                  >
                    <FileText size={11} className="shrink-0 opacity-70" />
                    <span className="truncate">{e.title}</span>
                  </button>
                ))}
              </div>
            );
          })}
          </>
          )}
        </nav>

        {/* Reading pane */}
        <div ref={paneRef} className="flex-1 min-w-0 overflow-y-auto">
          {loading
            ? <div className="p-4 text-xs text-fg-3 italic">Loading…</div>
            : <div className="docs-md px-5 py-4" onClick={onPaneClick} dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      </div>
    </div>
  );
};

// Scoped styling for the raw markdown HTML.
//
// ON THE DESIGN TOKENS, with the old grey kept as the fallback. Every border and code background used
// to come from a flat rgba(128,128,128,…), and links were #4ea1ff — a blue that appears NOWHERE else
// in ArtLux. The docs are part of the app rather than a web page inside it, so they read --accent,
// --line-1/2 and --surface-0/2/3 like every other panel; the fallbacks keep this legible if the HTML
// is ever rendered somewhere those tokens are not defined.
const DOCS_CSS = `
.docs-md { font-size: 13px; line-height: 1.65; }
.docs-md > :first-child { margin-top: 0; }
.docs-md h1 { font-size: 1.5em; font-weight: 700; margin: 1.2em 0 .5em; padding-bottom: .3em; border-bottom: 1px solid var(--line-2, rgba(128,128,128,.25)); }
.docs-md h2 { font-size: 1.25em; font-weight: 700; margin: 1.4em 0 .5em; padding-bottom: .2em; border-bottom: 1px solid var(--line-1, rgba(128,128,128,.18)); }
.docs-md h3 { font-size: 1.08em; font-weight: 600; margin: 1.2em 0 .4em; }
.docs-md h4, .docs-md h5 { font-weight: 600; margin: 1em 0 .3em; }
.docs-md p { margin: .6em 0; }
.docs-md ul, .docs-md ol { margin: .5em 0; padding-left: 1.5em; }
.docs-md li { margin: .25em 0; }
.docs-md a { color: var(--accent, #4ea1ff); text-decoration: none; }
.docs-md a:hover { text-decoration: underline; }
.docs-md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; background: var(--surface-3, rgba(128,128,128,.16)); padding: .12em .35em; border-radius: 4px; }
.docs-md pre { background: var(--surface-0, rgba(128,128,128,.12)); border: 1px solid var(--line-1, transparent); padding: .8em 1em; border-radius: 8px; overflow-x: auto; margin: .8em 0; }
.docs-md pre code { background: none; padding: 0; font-size: .85em; line-height: 1.5; }
.docs-md blockquote { margin: .8em 0; padding: .1em 1em; border-left: 3px solid var(--accent, rgba(128,128,128,.4)); opacity: .85; }
.docs-md table { border-collapse: collapse; width: 100%; margin: .9em 0; display: block; overflow-x: auto; }
.docs-md th, .docs-md td { border: 1px solid var(--line-1, rgba(128,128,128,.3)); padding: .4em .7em; text-align: left; vertical-align: top; }
.docs-md th { background: var(--surface-2, rgba(128,128,128,.14)); font-weight: 600; }
.docs-md td code { white-space: nowrap; }
.docs-md img { max-width: 100%; border-radius: 6px; margin: .5em 0; border: 1px solid var(--line-1, rgba(128,128,128,.2)); }
.docs-md .docs-img-missing { display: inline-block; margin: .5em 0; padding: .5em .8em; font-size: .82em; font-style: italic; opacity: .6; border: 1px dashed var(--line-2, rgba(128,128,128,.4)); border-radius: 6px; }
.docs-md hr { border: none; border-top: 1px solid var(--line-1, rgba(128,128,128,.25)); margin: 1.4em 0; }
`;
