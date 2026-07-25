import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useResizable } from '../hooks/useResizable';

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
  onResize?: (h: number) => void;
  children: React.ReactNode;
}

// Bottom dock with tab header + collapse, hosting monitors/editors. Drag the top edge to resize.
export const Dock: React.FC<Props> = ({ open, onToggle, tabs, activeTab, onTab, height = 280, onResize, children }) => {
  // Drag the top edge to resize (grows upward). Only rendered when open && onResize (see below).
  const onResizeDown = useResizable({
    axis: 'y', invert: true, value: height, min: 120,
    max: () => window.innerHeight - 120,
    onChange: (h) => onResize?.(h),
  });
  return (
  <div className="shrink-0 border-t border-line-1 bg-surface-1 flex flex-col transition-[height] duration-med ease-out relative" style={{ height: open ? height : 34 }}>
    {open && onResize && (
      <div onPointerDown={onResizeDown} title="Drag to resize" className="absolute -top-1 left-0 right-0 h-2 cursor-row-resize z-10 hover:bg-accent/30" />
    )}
    <div className="h-[34px] shrink-0 flex items-center justify-between px-2 border-b border-line-1 bg-surface-2 gap-2">
      {/* overflow-x-auto + min-w-0: plugin contexts (tracking, show) append tabs that used to overflow
          INTO the collapse button with no scroll (the ActionBar got this; the Dock didn't). */}
      <div className="flex items-center gap-1 overflow-x-auto min-w-0" role="tablist" aria-label="Dock panels">
        {tabs.map((t) => {
          const active = open && t.id === activeTab;
          return (
            <button
              key={t.id}
              onClick={() => { if (!open) onToggle(); onTab(t.id); }}
              role="tab"
              aria-selected={active}
              className={`flex items-center gap-1.5 h-6 px-2 rounded-sm text-mini transition-colors shrink-0 ${
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
        className="inline-flex items-center justify-center h-6 w-6 rounded-sm text-fg-2 hover:text-fg-1 hover:bg-surface-3"
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
};
