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
    /** When open, flex-grow to fill the parent column and scroll the body internally. */
    grow?: boolean;
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
    grow = false,
}) => {
    const [open, setOpen] = useState(defaultOpen);
    const growing = grow && open;

    return (
        <div className={`border-b border-line-1 ${growing ? 'flex-1 min-h-0 flex flex-col' : ''}`}>
            <div
                onClick={() => setOpen(o => !o)}
                // `pressable` opts this into the interaction-state floor (index.css): it is a control, but it
                // cannot be a <button> — it hosts an action slot, and a button inside a button is invalid HTML.
                className="pressable h-8 shrink-0 bg-surface-2 flex items-center px-2 justify-between cursor-pointer hover:bg-surface-3 select-none"
            >
                <div className="flex items-center gap-1.5 min-w-0">
                    <ChevronDown
                        size={12}
                        className={`text-fg-3 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`}
                    />
                    {icon && <span className="text-fg-3 shrink-0">{icon}</span>}
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-micro truncate">{title}</span>
                </div>
                {action && (
                    <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {action}
                    </div>
                )}
            </div>
            {open && <div className={`${bodyClassName} ${growing ? 'flex-1 min-h-0 overflow-y-auto' : ''}`}>{children}</div>}
        </div>
    );
};
