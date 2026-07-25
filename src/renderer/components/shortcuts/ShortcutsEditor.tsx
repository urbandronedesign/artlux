import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Search, Keyboard, RotateCcw, AlertTriangle } from 'lucide-react';
import { SHORTCUT_DEFS } from '../../shortcuts/registry';
import { keymap } from '../../shortcuts/keymapStore';
import { eventToChord, formatChord, isModifierKey } from '../../shortcuts/chord';
import type { ShortcutDef } from '../../shortcuts/types';
import { shortcutsNav } from '../../services/shortcutsNav';

// The full-page Keyboard Shortcuts editor — a centered overlay over the shortcut registry, modelled on
// HelpBrowser (self-owned open state via shortcutsNav, App holds no state). Left: a searchable list of
// every rebindable action grouped by category. Right: the selected action with its current binding, a
// click-to-record rebind, per-row reset and a reset-all. Rebinds persist immediately through keymap.
//
// Conflict policy (as chosen): a new binding that collides with another action IN THE SAME SCOPE is
// blocked and named; a different-scope reuse (a timeline key that also exists globally) is allowed,
// because the timeline handler only fires while the timeline is focused.

// Subsequence fuzzy match, mirrored from HelpBrowser.score().
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

// A human label for a scope, for the detail pane / list badges.
const SCOPE_LABEL: Record<string, string> = {
  global: 'Global', timeline: 'Timeline', projector: 'Projector', stategraph: 'State graph',
};

const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="text-micro text-fg-2 border border-line-2 rounded px-1.5 py-0.5 bg-surface-2">{children}</kbd>
);

export const ShortcutsEditor: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [conflict, setConflict] = useState<string>('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-render whenever a binding changes (keymap is a module singleton, not React state).
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => keymap.subscribe(force), []);

  // Open on request from openShortcuts() (Preferences button, menu item).
  useEffect(() => shortcutsNav.subscribe(() => { setOpen(true); setQ(''); setConflict(''); }), []);

  // ESC closes from anywhere in the overlay (unless we're mid-record — then it cancels the record).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (recording) return; // the capture-phase recorder owns keys while arming
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, recording]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const results = useMemo(() => {
    const scored = SHORTCUT_DEFS
      .map((d) => ({
        d,
        s: Math.max(
          score(q, d.label),
          score(q, `${d.category} ${d.label}`) - 30,
          score(q, SCOPE_LABEL[d.scope] ?? d.scope) - 40,
        ),
      }))
      .filter((x) => x.s >= 0);
    scored.sort((a, b) => b.s - a.s || a.d.label.localeCompare(b.d.label));
    return scored.map((x) => x.d);
  }, [q]);

  // Group the (filtered) results by category, preserving first-seen order.
  const groups = useMemo(() => {
    const m = new Map<string, ShortcutDef[]>();
    for (const d of results) { (m.get(d.category) ?? m.set(d.category, []).get(d.category)!).push(d); }
    return [...m.entries()];
  }, [results]);

  const selected = (selId ? SHORTCUT_DEFS.find((d) => d.id === selId) : undefined) ?? results[0];

  // Arm capture: the NEXT non-modifier keydown becomes the new binding, replacing the current one. Runs
  // in the capture phase with preventDefault so it never leaks to the app's own handlers while arming.
  useEffect(() => {
    if (!recording || !selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRecording(false); return; }
      if (isModifierKey(e.key)) return; // wait for the real key
      e.preventDefault(); e.stopPropagation();
      const chord = eventToChord(e);
      if (!chord) return;
      const clash = keymap.findConflict(chord, selected.scope, selected.id);
      if (clash) {
        setConflict(`"${formatChord(chord)}" is already bound to "${clash.label}" in ${SCOPE_LABEL[selected.scope]}.`);
        setRecording(false);
        return;
      }
      keymap.setBinding(selected.id, [chord]);
      setConflict('');
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, selected]);

  if (!open) return null;

  const close = () => { setRecording(false); setOpen(false); };

  return (
    <div className="fixed inset-0 z-modal bg-black/50 flex items-start justify-center pt-[10vh]" onClick={close}>
      <div
        role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
        className="w-[820px] max-w-[94vw] h-[68vh] bg-surface-1 border border-line-2 rounded-lg shadow-e3 overflow-hidden animate-modal-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header / search */}
        <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-line-1 bg-surface-2">
          <Keyboard size={14} className="text-accent shrink-0" />
          <span className="text-sm font-semibold text-fg-1 shrink-0">Keyboard shortcuts</span>
          <div className="flex items-center gap-2 flex-1 min-w-0 ml-3">
            <Search size={13} className="text-fg-3 shrink-0" />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => { setQ(e.target.value); setSelId(null); }}
              placeholder="Search actions…"
              className="flex-1 bg-transparent outline-none text-sm text-fg-1 placeholder:text-fg-3"
            />
          </div>
          <button
            onClick={() => { keymap.resetAll(); setConflict(''); }}
            className="text-mini text-fg-3 hover:text-fg-1 flex items-center gap-1 shrink-0"
            title="Restore every shortcut to its default"
          >
            <RotateCcw size={12} /> Reset all
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* List */}
          <div className="w-72 shrink-0 overflow-y-auto border-r border-line-1 py-1">
            {results.length === 0 && (
              <div className="px-3 py-6 text-center text-fg-3 text-mini italic">No match.</div>
            )}
            {groups.map(([cat, defs]) => (
              <div key={cat}>
                <div className="px-3 pt-2 pb-1 text-micro uppercase tracking-wider text-fg-3">{cat}</div>
                {defs.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => { setSelId(d.id); setRecording(false); setConflict(''); }}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                      selected?.id === d.id ? 'bg-accent/15 text-fg-1' : 'text-fg-2'
                    }`}
                  >
                    <span className="text-xs truncate flex-1">{d.label}</span>
                    <span className="flex gap-1 shrink-0">
                      {keymap.resolve(d.id).map((c) => <Chip key={c}>{formatChord(c)}</Chip>)}
                      {keymap.resolve(d.id).length === 0 && <span className="text-micro text-fg-3 italic">unbound</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Detail */}
          <div className="flex-1 min-w-0 overflow-y-auto p-5">
            {selected ? (
              <>
                <div className="text-micro uppercase tracking-wider text-fg-3 mb-1">
                  {SCOPE_LABEL[selected.scope] ?? selected.scope} · {selected.category}
                </div>
                <h2 className="text-base font-semibold text-fg-1 mb-1">{selected.label}</h2>
                {selected.description && (
                  <p className="text-mini text-fg-3 mb-4">{selected.description}</p>
                )}

                <div className="text-mini text-fg-3 mb-1.5 mt-3">Current binding</div>
                <div className="flex items-center gap-2 flex-wrap mb-4">
                  {keymap.resolve(selected.id).map((c) => <Chip key={c}>{formatChord(c)}</Chip>)}
                  {keymap.resolve(selected.id).length === 0 && (
                    <span className="text-mini text-fg-3 italic">Unbound</span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setConflict(''); setRecording(true); }}
                    className={`px-3 py-1.5 rounded text-xs font-medium border ${
                      recording
                        ? 'border-accent text-accent bg-accent/10 animate-pulse'
                        : 'border-line-2 text-fg-1 bg-surface-2 hover:bg-surface-3'
                    }`}
                  >
                    {recording ? 'Press a key…  (Esc to cancel)' : 'Record new shortcut'}
                  </button>
                  {keymap.isOverridden(selected.id) && (
                    <button
                      onClick={() => { keymap.resetBinding(selected.id); setConflict(''); }}
                      className="px-3 py-1.5 rounded text-xs text-fg-3 hover:text-fg-1 flex items-center gap-1"
                    >
                      <RotateCcw size={12} /> Reset to default
                    </button>
                  )}
                </div>

                {conflict && (
                  <div className="mt-3 flex items-start gap-1.5 text-xs text-warn">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    <span>{conflict}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-fg-3 text-mini italic">
                Select an action to rebind it.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
