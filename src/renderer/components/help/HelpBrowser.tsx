import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, HelpCircle } from 'lucide-react';
import { allHelpEntries, type HelpEntry } from '../../help/registry';
import { HELP_TOPICS } from '../../help/helpContent';
import { helpNav } from '../../services/helpNav';
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

// Subsequence fuzzy match, mirrored from CommandPalette.score(): exact prefix > substring > scattered.
// -1 means no match; higher is better.
function score(needle: string, hay: string): number {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  if (h.startsWith(n)) return 1000;
  const direct = h.indexOf(n);
  if (direct >= 0) return 500 - direct;
  let i = 0, gaps = 0, last = -1;
  for (let j = 0; j < h.length && i < n.length; j++) {
    if (h[j] === n[i]) { if (last >= 0) gaps += j - last - 1; last = j; i++; }
  }
  return i === n.length ? 100 - Math.min(99, gaps) : -1;
}

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

  const results = useMemo(() => {
    // Empty query = declaration order: Guides first, then the per-area authoring order — a table of
    // contents, not an alphabetized word heap (localeCompare on ~300 titles reads as noise).
    if (!q) return entries;
    const scored = entries
      .map((e) => ({
        e,
        s: Math.max(
          score(q, e.title),
          score(q, `${e.group ?? ''} ${e.title}`) - 50,
          ...(e.keywords ?? []).map((k) => score(q, k) - 30),
        ),
      }))
      .filter((x) => x.s >= 0);
    scored.sort((a, b) => b.s - a.s || a.e.title.localeCompare(b.e.title));
    return scored.map((x) => x.e);
  }, [entries, q]);

  // Keep a valid selection: prefer the requested id, else the top result.
  const selected: HelpEntry | undefined =
    (selId ? entries.find((e) => e.id === selId) : undefined) ?? results[0];

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
            {results.map((e) => (
              <button
                key={e.id}
                data-entry={e.id}
                onClick={() => setSelId(e.id)}
                className={`w-full flex flex-col items-start gap-0.5 px-3 py-1.5 text-left ${
                  selected?.id === e.id ? 'bg-accent/15 text-fg-1' : 'text-fg-2'
                }`}
              >
                <span className="text-xs truncate w-full">{e.title}</span>
                {e.group && <span className="text-micro text-fg-3">{e.group}</span>}
              </button>
            ))}
          </div>

          {/* Reading pane */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5">
            {selected ? (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <HelpCircle size={16} className="text-accent shrink-0" />
                  <h2 className="text-base font-semibold text-fg-1">{selected.title}</h2>
                  {selected.shortcut && (
                    <kbd className="text-micro text-fg-3 border border-line-2 rounded px-1 ml-auto">{selected.shortcut}</kbd>
                  )}
                </div>
                {selected.group && (
                  <div className="text-micro uppercase tracking-wider text-fg-3 mb-3">{selected.group}</div>
                )}
                <p className="text-sm leading-relaxed text-fg-2 whitespace-pre-line">
                  {selected.body ?? selected.short}
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
