import React from 'react';

interface Props {
  selected?: boolean;
  swatch?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode; // shown on hover / keyboard focus
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Roving-tabindex support: pass 0 for the active row and -1 for the rest (see useRovingTabindex).
   *  Defaults to 0 so a lone ListRow is reachable by Tab out of the box. */
  tabIndex?: number;
  /** Accessible name when the visible children aren't descriptive text. */
  ariaLabel?: string;
  children: React.ReactNode;
}

// Compact browser/tree row with a color swatch chip + teal selected state.
//
// This is the app's primary selection primitive (surfaces, fixtures, groups, scenes). It used to be a
// bare <div onClick>: mouse-only, invisible to assistive tech, and the reason the whole object-browser
// flow was keyboard-unreachable. It is now a real button — role + focusable + Enter/Space — so fixing
// it once fixed selection everywhere it's used. The interaction-state film already covers [role=button].
export const ListRow: React.FC<Props> = ({ selected, swatch, icon, actions, onClick, onDoubleClick, tabIndex = 0, ariaLabel, children }) => (
  <div
    role="button"
    tabIndex={tabIndex}
    aria-pressed={selected}
    aria-label={ariaLabel}
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    onKeyDown={(e) => {
      // Only when the ROW itself is focused — let a focused inner action button handle its own keys.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
    }}
    className={`group flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer transition-colors text-xs ${
      selected ? 'bg-accent/10 text-fg-1' : 'text-fg-2 hover:bg-surface-2'
    }`}
  >
    {swatch !== undefined && <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: swatch }} />}
    {icon}
    <span className="flex-1 truncate select-none">{children}</span>
    {/* Reveal row actions on hover AND on keyboard focus (of the row or anything inside it), so the
        delete/edit buttons a mouse user finds by hovering are also reachable by a Tab user. */}
    {actions && <div className="opacity-0 group-hover:opacity-100 group-focus:opacity-100 group-focus-within:opacity-100 flex items-center gap-1">{actions}</div>}
  </div>
);
