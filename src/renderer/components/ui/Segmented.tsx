import React from 'react';

interface Option<T> {
  value: T;
  label?: string;
  icon?: React.ReactNode;
  title?: string;
}

interface Props<T extends string | number> {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}

export function Segmented<T extends string | number>({ options, value, onChange, className = '' }: Props<T>) {
  return (
    // radiogroup/radio semantics + aria-checked make the selection announceable; the active segment
    // also carries a NON-COLOR cue (inset ring + bolder weight), so it isn't a hue difference alone —
    // mis-reading the selected pixel format (RGB vs RGBW) here is a real output bug.
    <div role="radiogroup" className={`inline-flex rounded-sm overflow-hidden border border-line-1 ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`flex items-center justify-center gap-1 px-2 h-7 text-mini transition-colors ${
              active ? 'bg-accent/15 text-accent font-semibold ring-1 ring-inset ring-accent' : 'bg-surface-2 text-fg-2 hover:bg-surface-3'
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
