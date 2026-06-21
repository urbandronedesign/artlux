import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface DockTabDef {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface Props {
  open: boolean;
  onToggle: () => void;
  tabs: DockTabDef[];
  activeTab: string;
  onTab: (id: string) => void;
  height?: number;
  children: React.ReactNode;
}

// Bottom dock with tab header + collapse, hosting monitors/editors.
export const Dock: React.FC<Props> = ({ open, onToggle, tabs, activeTab, onTab, height = 280, children }) => (
  <div className="shrink-0 border-t border-line-1 bg-surface-1 flex flex-col transition-[height] duration-200 ease-out" style={{ height: open ? height : 34 }}>
    <div className="h-[34px] shrink-0 flex items-center justify-between px-2 border-b border-line-1 bg-surface-2">
      <div className="flex items-center gap-1" role="tablist" aria-label="Dock panels">
        {tabs.map((t) => {
          const active = open && t.id === activeTab;
          return (
            <button
              key={t.id}
              onClick={() => { if (!open) onToggle(); onTab(t.id); }}
              role="tab"
              aria-selected={active}
              className={`flex items-center gap-1.5 h-6 px-2 rounded-[var(--r-sm)] text-[11px] transition-colors ${
                active ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:text-fg-1 hover:bg-surface-3'
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>
      <button
        onClick={onToggle}
        className="inline-flex items-center justify-center h-6 w-6 rounded-[var(--r-sm)] text-fg-2 hover:text-fg-1 hover:bg-surface-3"
        title={open ? 'Collapse' : 'Expand'}
        aria-label={open ? 'Collapse dock' : 'Expand dock'}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </button>
    </div>
    {open && <div className="flex-1 min-h-0 overflow-auto">{children}</div>}
  </div>
);
