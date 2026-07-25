import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, HelpCircle } from 'lucide-react';
import { allHelpEntries, type HelpEntry } from '../../help/registry';
import { helpNav } from '../../services/helpNav';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// The searchable Help Page — a Ctrl+K-style centered overlay over the per-function help registry.
//
// It is the "search every function" surface: a fuzzy-searched list on the left, the selected entry's
// explanation on the right. It self-owns its open state exactly like CommandPalette — Shift+F1 toggles
// it, and it subscribes to helpNav so a tooltip's "? Learn more" link (openHelp(id)) opens it focused
// on that entry. App needs no new state for this.
//
// The registry IS the index (same trick that makes CommandPalette nearly free), so there is no IPC and
// nothing is registered twice: an entry authored for a tooltip appears here automatically.

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

export const HelpBrowser: React.FC = () => {
  const [open, setOpen] = useState(false);
  const trapRef = useFocusTrap(open);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => allHelpEntries(), []);

  // Shift+F1 toggles (F1 alone is the contextual HelpPanel — this is "search all help"). Not suppressed
  // while typing: the whole point is to reach a function's help without leaving the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1' && e.shiftKey) {
        e.preventDefault();
        setOpen((v) => !v);
        setQ('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A tooltip link (openHelp) opens us focused on its entry; openHelp() with no id opens at the top.
  useEffect(() => helpNav.subscribe((id) => {
    setOpen(true);
    setQ('');
    setSelId(id);
  }), []);

  // ESC closes from ANYWHERE in the overlay, not just the search input: clicking a result moves focus
  // to that button, so an input-only handler leaves ESC dead the moment you pick something. A global
  // keydown while open is the reliable close (matches the overlay's click-outside-to-close).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const results = useMemo(() => {
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
    if (!open || !selId) return;
    const el = listRef.current?.querySelector(`[data-entry="${CSS.escape(selId)}"]`) as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, selId, results]);

  if (!open) return null;

  const close = () => setOpen(false);

  return (
    <div className="fixed inset-0 z-modal bg-black/50 flex items-start justify-center pt-[10vh]" onClick={close}>
      <div
        ref={trapRef}
        role="dialog" aria-modal="true" aria-label="Search help"
        className="w-[760px] max-w-[94vw] h-[64vh] bg-surface-1 border border-line-2 rounded-lg shadow-e3 overflow-hidden animate-modal-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-line-1 bg-surface-2">
          <Search size={14} className="text-fg-3 shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSelId(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
            placeholder="Search every function…"
            className="flex-1 bg-transparent outline-none text-sm text-fg-1 placeholder:text-fg-3"
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
