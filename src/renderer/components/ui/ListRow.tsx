import React from 'react';

interface Props {
  selected?: boolean;
  swatch?: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode; // shown on hover (group-hover)
  onClick?: () => void;
  onDoubleClick?: () => void;
  children: React.ReactNode;
}

// Compact browser/tree row with a color swatch chip + teal selected state.
export const ListRow: React.FC<Props> = ({ selected, swatch, icon, actions, onClick, onDoubleClick, children }) => (
  <div
    onClick={onClick}
    onDoubleClick={onDoubleClick}
    className={`group flex items-center gap-2 px-2 py-1.5 rounded-sm cursor-pointer transition-colors text-xs ${
      selected ? 'bg-accent/10 text-fg-1' : 'text-fg-2 hover:bg-surface-2'
    }`}
  >
    {swatch !== undefined && <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: swatch }} />}
    {icon}
    <span className="flex-1 truncate select-none">{children}</span>
    {actions && <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">{actions}</div>}
  </div>
);
