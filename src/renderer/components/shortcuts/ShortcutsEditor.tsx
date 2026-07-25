import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { Search, Keyboard, RotateCcw, AlertTriangle } from 'lucide-react';
import { SHORTCUT_DEFS } from '../../shortcuts/registry';
import { keymap } from '../../shortcuts/keymapStore';
import { eventToChord, formatChord, isModifierKey } from '../../shortcuts/chord';
import type { ShortcutDef } from '../../shortcuts/types';
import { shortcutsNav } from '../../services/shortcutsNav';

// The full-page Keyboard Shortcuts editor — a centered overlay over the shortcut registry, self-owning
// its open state via shortcutsNav (App holds no state, like HelpBrowser).
//
// Layout: an Excel-style TABLE. One row per rebindable action, ruled off from the next; a category
// header row breaks the groups. The shortcut CELL itself is the control — click it and it arms directly,
// capturing the next key press as the new binding (no separate Record button). Rebinds persist at once.
//
// Conflict policy: a new binding that collides with another action IN THE SAME SCOPE is blocked and
// named; reuse across different scopes is allowed (a timeline key only fires while the timeline is
// focused), so it is fine for it to shadow a global one.

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

const SCOPE_LABEL: Record<string, string> = {
  global: 'Global', timeline: 'Timeline', projector: 'Projector', stategraph: 'State graph',
};

const Chip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className="text-micro text-fg-2 border border-line-2 rounded px-1.5 py-0.5 bg-surface-2">{children}</kbd>
);

export const ShortcutsEditor: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // The action whose shortcut cell is currently armed and listening for a key (null = none).
  const [recordingId, setRecordingId] = useState<string | null>(null);
  // The one action whose last record attempt collided, and the message to show under its cell.
  const [conflict, setConflict] = useState<{ id: string; msg: string } | null>(null);

  // Re-render whenever a binding changes (keymap is a module singleton, not React state).
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => keymap.subscribe(force), []);

  // Open on request from openShortcuts() (menu items).
  useEffect(() => shortcutsNav.subscribe(() => { setOpen(true); setQ(''); setConflict(null); setRecordingId(null); }), []);

  // ESC closes from anywhere in the overlay — unless a cell is armed, where ESC cancels the record.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (recordingId) return; // the capture-phase recorder owns keys while armed
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, recordingId]);

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

  // Arm capture for the recording cell: the NEXT non-modifier keydown becomes its new binding, replacing
  // the current one. Capture-phase + preventDefault so it never leaks to the app's own handlers.
  useEffect(() => {
    if (!recordingId) return;
    const def = SHORTCUT_DEFS.find((d) => d.id === recordingId);
    if (!def) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRecordingId(null); return; }
      if (isModifierKey(e.key)) return; // wait for the real key
      e.preventDefault(); e.stopPropagation();
      const chord = eventToChord(e);
      if (!chord) return;
      const clash = keymap.findConflict(chord, def.scope, def.id);
      if (clash) {
        setConflict({ id: def.id, msg: `"${formatChord(chord)}" is already used by "${clash.label}".` });
        setRecordingId(null);
        return;
      }
      keymap.setBinding(def.id, [chord]);
      setConflict(null);
      setRecordingId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingId]);

  if (!open) return null;

  const close = () => { setRecordingId(null); setOpen(false); };
  const arm = (id: string) => { setConflict(null); setRecordingId((cur) => (cur === id ? null : id)); };

  return (
    <div className="fixed inset-0 z-modal bg-black/50 flex items-start justify-center pt-[8vh]" onClick={close}>
      <div
        role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
        className="w-[720px] max-w-[94vw] h-[74vh] bg-surface-1 border border-line-2 rounded-lg shadow-e3 overflow-hidden animate-modal-in flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header / search */}
        <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-line-1 bg-surface-2">
          <Keyboard size={14} className="text-accent shrink-0" />
          <span className="text-sm font-semibold text-fg-1 shrink-0">Keyboard shortcuts</span>
          <div className="flex items-center gap-2 flex-1 min-w-0 ml-3">
            <Search size={13} className="text-fg-3 shrink-0" />
            <input
              value={q}
              autoFocus
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search actions…"
              className="flex-1 bg-transparent outline-none text-sm text-fg-1 placeholder:text-fg-3"
            />
          </div>
          <button
            onClick={() => { keymap.resetAll(); setConflict(null); setRecordingId(null); }}
            className="text-mini text-fg-3 hover:text-fg-1 flex items-center gap-1 shrink-0"
            title="Restore every shortcut to its default"
          >
            <RotateCcw size={12} /> Reset all
          </button>
        </div>

        {/* Column header — the two ruled columns of the sheet. */}
        <div className="grid grid-cols-[1fr_240px] shrink-0 border-b border-line-2 bg-surface-2 text-micro uppercase tracking-wider text-fg-3">
          <div className="px-3 py-1.5">Action</div>
          <div className="px-3 py-1.5 border-l border-line-2">Shortcut</div>
        </div>

        {/* The sheet */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {results.length === 0 && (
            <div className="px-3 py-8 text-center text-fg-3 text-mini italic">No match.</div>
          )}
          {groups.map(([cat, defs]) => (
            <div key={cat}>
              {/* Category band, spanning both columns. */}
              <div className="px-3 py-1 text-micro uppercase tracking-wider text-fg-3 bg-surface-2/60 border-b border-line-1">
                {cat}
              </div>
              {defs.map((d) => {
                const binds = keymap.resolve(d.id);
                const rec = recordingId === d.id;
                const hasConflict = conflict?.id === d.id;
                return (
                  <div key={d.id} className="group grid grid-cols-[1fr_240px] items-stretch border-b border-line-1">
                    {/* Action cell */}
                    <div className="px-3 py-2 flex flex-col justify-center min-w-0">
                      <span className="text-xs text-fg-1 truncate">{d.label}</span>
                      <span className="text-micro text-fg-3">{SCOPE_LABEL[d.scope] ?? d.scope}</span>
                    </div>

                    {/* Shortcut cell — click to record. This IS the control (no button). */}
                    <div className="border-l border-line-1 flex items-center gap-1.5 px-2">
                      <button
                        onClick={() => arm(d.id)}
                        title={rec ? 'Press a key… (Esc to cancel)' : 'Click to change'}
                        className={`flex-1 min-w-0 h-full flex items-center gap-1.5 px-1.5 py-2 text-left rounded-sm ${
                          rec
                            ? 'bg-accent/15 ring-1 ring-accent'
                            : hasConflict
                              ? 'bg-danger/10'
                              : 'hover:bg-white/5'
                        }`}
                      >
                        {rec ? (
                          <span className="text-mini text-accent animate-pulse">Press a key…</span>
                        ) : binds.length ? (
                          binds.map((c) => <Chip key={c}>{formatChord(c)}</Chip>)
                        ) : (
                          <span className="text-mini text-fg-3 italic">Unbound</span>
                        )}
                      </button>
                      {/* Per-row reset — appears on hover / when overridden. */}
                      {keymap.isOverridden(d.id) && !rec && (
                        <button
                          onClick={() => { keymap.resetBinding(d.id); if (hasConflict) setConflict(null); }}
                          title="Reset to default"
                          className="shrink-0 p-1 text-fg-3 hover:text-fg-1 opacity-0 group-hover:opacity-100"
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </div>

                    {/* Conflict line, under the row, spanning both columns. */}
                    {hasConflict && (
                      <div className="col-span-2 px-3 pb-1.5 -mt-1 flex items-start gap-1.5 text-mini text-warn">
                        <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                        <span>{conflict!.msg}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="shrink-0 px-3 h-8 flex items-center text-micro text-fg-3 border-t border-line-1 bg-surface-2">
          Click a shortcut cell, then press the keys. Conflicts within the same scope are blocked.
        </div>
      </div>
    </div>
  );
};
