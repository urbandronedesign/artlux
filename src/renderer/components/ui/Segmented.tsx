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
    <div className={`inline-flex rounded-sm overflow-hidden border border-line-1 ${className}`}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`flex items-center justify-center gap-1 px-2 h-7 text-mini transition-colors ${
              active ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-fg-2 hover:bg-surface-3'
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
