import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface Props {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

// Collapsible property section (MadMapper-style inspector group).
export const Section: React.FC<Props> = ({ title, icon, defaultOpen = true, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-line-1">
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 bg-surface-2 hover:bg-surface-3 flex items-center justify-between transition-colors"
      >
        <span className="flex items-center gap-2 text-mini font-semibold text-fg-2 uppercase tracking-wider">
          {icon && <span className="text-fg-3">{icon}</span>}
          {title}
        </span>
        <ChevronDown size={12} className={`text-fg-3 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="p-3 bg-surface-1 space-y-3">{children}</div>}
    </div>
  );
};
