import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface Props {
    title: string;
    icon?: React.ReactNode;
    /** Rendered on the right of the header; clicking it does NOT toggle the section. */
    action?: React.ReactNode;
    defaultOpen?: boolean;
    children: React.ReactNode;
    bodyClassName?: string;
}

/**
 * Independently collapsible panel section. Clicking the header toggles open/closed;
 * clicking the `action` node is swallowed so header buttons (add, capture, …) work.
 */
export const CollapsibleSection: React.FC<Props> = ({
    title,
    icon,
    action,
    defaultOpen = true,
    children,
    bodyClassName = '',
}) => {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="border-b border-line-1">
            <div
                onClick={() => setOpen(o => !o)}
                className="h-8 bg-surface-2 flex items-center px-2 justify-between cursor-pointer hover:bg-surface-3 select-none"
            >
                <div className="flex items-center gap-1.5 min-w-0">
                    <ChevronDown
                        size={12}
                        className={`text-fg-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                    />
                    {icon && <span className="text-fg-3 shrink-0">{icon}</span>}
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px] truncate">{title}</span>
                </div>
                {action && (
                    <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {action}
                    </div>
                )}
            </div>
            {open && <div className={bodyClassName}>{children}</div>}
        </div>
    );
};
