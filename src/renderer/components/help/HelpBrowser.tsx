import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, HelpCircle, BookOpen, ArrowUpRight } from 'lucide-react';
import { allHelpEntries, type HelpEntry } from '../../help/registry';
import { HELP_TOPICS } from '../../help/helpContent';
import { helpNav } from '../../services/helpNav';
import { score, searchDocs, loadDocIndex, type DocHit } from '../../services/docSearch';
import type { DocChunk } from '../../../../shared/protocol';
import type { HelpLang } from '../../services/helpBus';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useEditor, useEditorActions } from '../../state/EditorStore';
import { Segmented } from '../ui';

// THE help surface — a Ctrl+K-style centered overlay, and the only one. It merged two surfaces that
// split one job (plans/help-merge-and-topbar-removal.md): the old right-drawer HelpPanel (F1, the
// coarse bilingual HELP_TOPICS guides + a live-hover line) and this search page (Shift+F1, the
// per-function registry). Both content stores survive unchanged; they meet here as two tiers of one
// fuzzy-searched list — "Guides" first, functions after. The drawer's live-hover line did NOT move
// in: you cannot hover the UI under a modal, and the StatusBar already renders the same helpBus hint
// permanently. F1 toggles; Shift+F1 stays as a silent alias for muscle memory. It subscribes to
// helpNav so a tooltip's "? Learn more" link (openHelp(id)) opens it focused on that entry, and the
// registry IS the index (same trick as CommandPalette), so there is no IPC and nothing registered
// twice.
//
// F1 is RENDERER-OWNED, like CommandPalette's Ctrl+K: the native menu item has no accelerator, the
// accel text in the custom MenuBar is display-only, and the keydown below is the single owner. Two
// owners is the bug — if the native accelerator consumed the key, toggle-to-close would silently
// die (a menu click can only open); if it didn't, one press would fire both and open-then-close.

// ── THE THIRD TIER: THE SHIPPED DOCUMENTATION (2026-07-29) ───────────────────────────────────────────
// This modal searched two stores that both describe CONTROLS — the coarse Guides and the 226
// per-function entries. The 66 pages of actual documentation (user guide, tutorials, reference) were
// searchable nowhere in the app: the Docs Browser was a tree, and Ctrl+F reached only the open page.
// An operator does not know which store holds their answer; they know the word "blade". So one query
// now returns the control AND the chapter, and picking a chapter opens it in the Docs window.
//
// `score()` moved to services/docSearch.ts so both surfaces rank identically — two rankers would order
// the same query two ways and the interleave would be arbitrary. See that file for why body text is
// matched by substring only.
//
// A doc row is a `doc:`-prefixed id, which cannot collide with `topic.` or the dotted registry ids.
const DOC_TIE_BREAK = 10;   // a control outranks a chapter at equal score: it is the more precise answer

type Row =
  | { kind: 'entry'; id: string; title: string; group?: string; s: number; entry: HelpEntry }
  | { kind: 'doc'; id: string; title: string; group: string; s: number; hit: DocHit };

// The Guides tier: each coarse HELP_TOPICS entry adapted into a registry-shaped entry for the
// language in effect. `topic.` cannot collide with the dotted area ids, so one list serves both
// tiers, and searching in French finds a guide by its French title. The adapter lives here — at the
// edge — deliberately: when FR is authored for the registry, the right move is to unify the two
// stores on the bilingual shape and delete this, not to grow it.
const topicEntries = (lang: HelpLang): HelpEntry[] =>
  HELP_TOPICS.map((t) => ({
    id: `topic.${t.id}`,
    title: t.title[lang],
    short: t.body[lang],
    body: t.body[lang],
    group: 'Guides',
    keywords: [t.title.en, t.title.fr],
  }));

export const HelpBrowser: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);

  // F1 toggles, shift or not (Shift+F1 was the old binding for this overlay — zero-cost alias). Not
  // suppressed while typing: the whole point is to reach a function's help without leaving the
  // keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setOpen((v) => !v);
        setQ('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A tooltip link (openHelp) opens us focused on its entry; openHelp() with no id — also the
  // Help ▸ Help… menu item — opens at the top. Open-only is correct for those doors: you cannot
  // click a menu under this focus-trapped overlay, so only the key needs toggle semantics.
  useEffect(() => helpNav.subscribe((id) => {
    setOpen(true);
    setQ('');
    setSelId(id);
  }), []);

  // The store-reading body mounts only while open. This split is load-bearing: the renderer
  // repaints per-frame during playback, and a useEditor() in THIS component would re-render at
  // frame rate to return null.
  if (!open) return null;
  return (
    <HelpBrowserBody
      q={q} setQ={setQ} selId={selId} setSelId={setSelId}
      onClose={() => setOpen(false)}
    />
  );
};

const HelpBrowserBody: React.FC<{
  q: string;
  setQ: (q: string) => void;
  selId: string | null;
  setSelId: (id: string | null) => void;
  onClose: () => void;
}> = ({ q, setQ, selId, setSelId, onClose }) => {
  const trapRef = useFocusTrap(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // EN/FR writes through to AppSettings.helpLang (persisted) — the same field the old drawer's
  // toggle wrote, so an operator's language survives the merge and the restart.
  const { settings } = useEditor();
  const { updateSettings } = useEditorActions();
  const lang = settings.helpLang;

  const entries = useMemo(() => [...topicEntries(lang), ...allHelpEntries()], [lang]);

  // The doc index is pulled once, lazily, when the modal first opens — not at app start. It is a
  // megabyte of prose that most sessions never search, and the service caches it for the window (and
  // main caches it across windows), so the cost is paid once by whoever actually asks.
  const [docs, setDocs] = useState<DocChunk[]>([]);
  useEffect(() => { let alive = true; loadDocIndex().then((c) => { if (alive) setDocs(c); }); return () => { alive = false; }; }, []);

  // ESC closes from ANYWHERE in the overlay, not just the search input: clicking a result moves focus
  // to that button, so an input-only handler leaves ESC dead the moment you pick something. A global
  // keydown while mounted is the reliable close (matches the overlay's click-outside-to-close).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo<Row[]>(() => {
    // Empty query = declaration order: Guides first, then the per-area authoring order — a table of
    // contents, not an alphabetized word heap (localeCompare on ~300 titles reads as noise). Docs are
    // NOT listed here: ~700 chunks would bury the contents list this view exists to be.
    if (!q) return entries.map((e) => ({ kind: 'entry' as const, id: e.id, title: e.title, group: e.group, s: 0, entry: e }));

    const rows: Row[] = entries
      .map((e) => ({
        kind: 'entry' as const,
        id: e.id,
        title: e.title,
        group: e.group,
        entry: e,
        s: Math.max(
          score(q, e.title),
          score(q, `${e.group ?? ''} ${e.title}`) - 50,
          ...(e.keywords ?? []).map((k) => score(q, k) - 30),
        ),
      }))
      .filter((x) => x.s >= 0);

    for (const hit of searchDocs(docs, q, 30)) {
      rows.push({
        kind: 'doc',
        id: `doc:${hit.chunk.id}`,
        title: hit.chunk.heading || hit.chunk.doc,
        group: hit.chunk.section,
        s: hit.s - DOC_TIE_BREAK,
        hit,
      });
    }

    rows.sort((a, b) => b.s - a.s || a.title.localeCompare(b.title));
    return rows;
  }, [entries, docs, q]);

  // Keep a valid selection: prefer the requested id, else the top result.
  const selected: Row | undefined =
    (selId ? results.find((r) => r.id === selId) : undefined) ?? results[0];

  // When a deep-link lands, bring the selected row into view.
  useEffect(() => {
    if (!selId) return;
    const el = listRef.current?.querySelector(`[data-entry="${CSS.escape(selId)}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selId, results]);

  return (
    <div className="fixed inset-0 z-modal bg-black/50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        ref={trapRef}
        role="dialog" aria-modal="true" aria-label="Help"
        className="w-[760px] max-w-[94vw] h-[64vh] bg-surface-1 border border-line-2 rounded-lg shadow-e3 overflow-hidden animate-modal-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input + language */}
        <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-line-1 bg-surface-2">
          <Search size={14} className="text-fg-3 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSelId(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
            placeholder={lang === 'fr' ? 'Rechercher dans l’aide…' : 'Search every function…'}
            className="flex-1 bg-transparent outline-none text-sm text-fg-1 placeholder:text-fg-3"
          />
          <Segmented<HelpLang>
            options={[{ value: 'en', label: 'EN' }, { value: 'fr', label: 'FR' }]}
            value={lang}
            onChange={(l) => updateSettings({ helpLang: l })}
          />
          <kbd className="text-micro text-fg-3 border border-line-2 rounded px-1">Esc</kbd>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* Results list */}
          <div ref={listRef} className="w-64 shrink-0 overflow-y-auto border-r border-line-1 py-1">
            {results.length === 0 && (
              <div className="px-3 py-6 text-center text-fg-3 text-mini italic">No match.</div>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                data-entry={r.id}
                onClick={() => setSelId(r.id)}
                className={`w-full flex flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
                  selected?.id === r.id ? 'bg-accent/15 text-fg-1' : 'text-fg-2'
                }`}
              >
                <span className="text-xs truncate w-full flex items-center gap-1.5">
                  {/* The icon is the tier: a page of documentation reads differently from a control. */}
                  {r.kind === 'doc' && <BookOpen size={11} className="shrink-0 opacity-60" />}
                  <span className="truncate">{r.title}</span>
                </span>
                {r.group && <span className="text-micro text-fg-3 truncate w-full">{r.group}</span>}
              </button>
            ))}
          </div>

          {/* Reading pane */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5">
            {selected?.kind === 'doc' ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <BookOpen size={16} className="text-accent shrink-0" />
                  <h2 className="text-base font-semibold text-fg-1">{selected.hit.chunk.heading || selected.hit.chunk.doc}</h2>
                </div>
                <div className="text-micro uppercase tracking-wider text-fg-3 mb-3">
                  {selected.hit.chunk.section} · {selected.hit.chunk.doc}
                </div>
                <p className="text-sm leading-relaxed text-fg-2 whitespace-pre-line">{selected.hit.chunk.text}</p>
                {/* The excerpt is a preview, not the page. The Docs window is where you READ — it renders
                    real markdown with tables and images, which this pane deliberately does not. */}
                <button
                  onClick={() => window.artlux.openDocsWindow(selected.hit.chunk.id)}
                  className="mt-4 inline-flex items-center gap-1.5 text-xs text-accent border border-line-2 rounded px-2.5 py-1.5"
                >
                  Open in Docs <ArrowUpRight size={13} />
                </button>
              </>
            ) : selected ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <HelpCircle size={16} className="text-accent shrink-0" />
                  <h2 className="text-base font-semibold text-fg-1">{selected.title}</h2>
                  {selected.entry.shortcut && (
                    <kbd className="text-micro text-fg-3 border border-line-2 rounded px-1 ml-auto">{selected.entry.shortcut}</kbd>
                  )}
                </div>
                {selected.group && (
                  <div className="text-micro uppercase tracking-wider text-fg-3 mb-3">{selected.group}</div>
                )}
                <p className="text-sm leading-relaxed text-fg-2 whitespace-pre-line">
                  {selected.entry.body ?? selected.entry.short}
                </p>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-fg-3 text-mini italic">
                Search for a function to see its help.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
