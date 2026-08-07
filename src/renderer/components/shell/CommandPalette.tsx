import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, CornerDownLeft } from 'lucide-react';
import type { SelectionSnapshot } from '@artlux/sdk/renderer';
import { contextRegistry } from '../../host/registries';
import { goToContext } from '../../contexts/nav';
import { useEditorActions } from '../../state/EditorStore';
import { useFocusTrap } from '../../hooks/useFocusTrap';

// Ctrl/Cmd+K — every workspace context and every action any context declares, in one searchable list.
//
// This is nearly free because the contexts already ARE the index: a WorkspaceContext names its
// functions as `ContextAction`s so the shell can draw an action bar, and the same declaration answers
// "what can this app do". Nothing is registered twice, and a plugin that appends actions to a context
// appears here without knowing the palette exists.
//
// Actions from OTHER contexts are runnable: picking one switches to its context first, so the operator
// lands where the work continues rather than firing a function into a workbench that can't show it.

interface Cmd {
  key: string;
  label: string;
  /** Context title, or 'Go to' for the context switches themselves. */
  group: string;
  hint?: string;
  run(): void;
  enabled: boolean;
}

// Subsequence match ("adfx" matches "Add Fixture"), the cheap fuzzy everyone expects from a palette.
// Returns a score so exact prefix hits sort above scattered ones; -1 means no match.
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

export const CommandPalette: React.FC<{ selection: SelectionSnapshot }> = ({ selection }) => {
  const [open, setOpen] = useState(false);
  const trapRef = useFocusTrap(open);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const actions = useEditorActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Ctrl/Cmd+K toggles. Unlike the rail's Ctrl+1..9 this is NOT suppressed while typing: the whole
  // point is to reach a function without leaving the keyboard, and K is not a value anyone is entering
  // into a numeric field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
        setQ(''); setI(0);
      }
    };
    // Also openable from the Help menu / a visible affordance, so it's discoverable without knowing
    // the shortcut (it was Ctrl+K-only and listed nowhere).
    const onOpenEvent = () => { setOpen((v) => !v); setQ(''); setI(0); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('artlux:toggle-command-palette', onOpenEvent as EventListener);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('artlux:toggle-command-palette', onOpenEvent as EventListener);
    };
  }, []);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    if (!open) return [];
    const list: Cmd[] = [];
    const contexts = contextRegistry.all();
    for (const c of contexts) {
      list.push({
        key: `ctx:${c.id}`, label: c.title, group: 'Go to', hint: 'workspace',
        run: () => goToContext(c.id), enabled: true,
      });
    }
    for (const c of contexts) {
      for (const a of c.actions ?? []) {
        list.push({
          key: `act:${c.id}:${a.id}`,
          // A live action reports its own label and availability ("Stop Recording", and enabled even
          // with nothing selected) — the palette must not offer a stale one.
          label: a.live?.get().label ?? a.label,
          group: c.title,
          hint: a.shortcut,
          enabled: a.live?.get().enabled ?? (a.enabled ? a.enabled(selection) : true),
          run: () => {
            // Land where the function makes sense before firing it — "Add Surface" from anywhere means
            // "go to Mapping and add a surface". But an action that acts on the APP rather than on the
            // workbench opts out with `stayPut`: arming a recorder must not move the workbench out from
            // under an operator mid-show, least of all one who reached it from Preferences.
            if (!a.stayPut) goToContext(c.id);
            if (a.run) a.run();
            else if (a.menuAction) actions.menuAction(a.menuAction);
          },
        });
      }
    }
    return list;
  }, [open, selection, actions]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: Math.max(score(q, c.label), score(q, `${c.group} ${c.label}`) - 50) }))
      .filter((x) => x.s >= 0);
    scored.sort((a, b) => b.s - a.s || a.c.label.localeCompare(b.c.label));
    return scored.slice(0, 40).map((x) => x.c);
  }, [commands, q]);

  useEffect(() => { setI(0); }, [q]);
  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const el = listRef.current?.children[i] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [i]);

  if (!open) return null;

  const run = (c: Cmd | undefined) => { if (!c || !c.enabled) return; setOpen(false); c.run(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((v) => Math.min(results.length - 1, v + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((v) => Math.max(0, v - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(results[i]); }
  };

  return (
    <div className="fixed inset-0 z-modal bg-black/50 flex items-start justify-center pt-[12vh]" onClick={() => setOpen(false)}>
      <div
        ref={trapRef}
        role="dialog" aria-modal="true" aria-label="Command palette"
        className="w-[560px] max-w-[92vw] bg-surface-1 border border-line-2 rounded-lg shadow-e3 overflow-hidden animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 h-11 border-b border-line-1 bg-surface-2">
          <Search size={14} className="text-fg-3 shrink-0" />
          <input
            ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
            placeholder="Go to a workspace, or run a command…"
            className="flex-1 bg-transparent outline-none text-sm text-fg-1 placeholder:text-fg-3"
          />
          <kbd className="text-micro text-fg-3 border border-line-2 rounded px-1">Esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {results.length === 0 && <div className="px-3 py-6 text-center text-fg-3 text-mini italic">No match.</div>}
          {results.map((c, idx) => (
            <button
              key={c.key}
              onMouseEnter={() => setI(idx)}
              onClick={() => run(c)}
              disabled={!c.enabled}
              className={`w-full flex items-center gap-2 px-3 h-8 text-left text-xs ${
                idx === i ? 'bg-accent/15 text-fg-1' : 'text-fg-2'
              } ${c.enabled ? '' : 'opacity-40 cursor-default'}`}
            >
              <span className="truncate flex-1">{c.label}</span>
              {c.hint && <span className="text-micro text-fg-3 shrink-0">{c.hint}</span>}
              <span className="text-micro text-fg-3 shrink-0 truncate max-w-[140px]">{c.group}</span>
              {idx === i && c.enabled && <CornerDownLeft size={12} className="text-fg-3 shrink-0" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
