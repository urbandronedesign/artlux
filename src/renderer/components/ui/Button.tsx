import React from 'react';
import { Tooltip } from './Tooltip';

type Variant = 'ghost' | 'tonal' | 'primary' | 'danger';
type Size = 'sm' | 'md';

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50 disabled:pointer-events-none';
const sizes: Record<Size, string> = { sm: 'h-6 px-2 text-mini', md: 'h-8 px-3 text-xs' };
const variants: Record<Variant, string> = {
  ghost: 'text-fg-2 hover:text-fg-1 hover:bg-surface-3',
  tonal: 'bg-surface-2 text-fg-1 border border-line-1 hover:bg-surface-3',
  primary: 'bg-accent text-black hover:bg-accent-hover',
  danger: 'bg-surface-2 text-danger border border-line-1 hover:bg-danger hover:text-white',
};

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button: React.FC<Props> = ({ variant = 'tonal', size = 'md', className = '', ...rest }) => {
  // Same opt-in as IconButton: a `data-help-id` (from helpBus' `help(id)`) auto-wraps the button in
  // Tooltip so the hint gains a "? Learn more" deep-link. Without it, renders exactly as before.
  const helpId = (rest as Record<string, unknown>)['data-help-id'];
  const btn = <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...rest} />;
  return typeof helpId === 'string' ? <Tooltip id={helpId}>{btn}</Tooltip> : btn;
};

interface IconBtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const IconButton: React.FC<IconBtnProps> = ({ active = false, className = '', ...rest }) => {
  // A control opts into the rich help tooltip by carrying `data-help-id` (from helpBus' `help(id)`).
  // When present we wrap the button in Tooltip so the hint gains a "? Learn more" deep-link; when not,
  // the plain button (with its native `title`) renders exactly as before — zero behaviour change.
  const helpId = (rest as Record<string, unknown>)['data-help-id'];
  const btn = (
    <button
      // Icon-only buttons need an accessible name; fall back to the tooltip text.
      aria-label={rest['aria-label'] ?? (typeof rest.title === 'string' ? rest.title : undefined)}
      aria-pressed={active || undefined}
      className={`inline-flex items-center justify-center h-7 w-7 rounded-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        active ? 'bg-accent/10 text-accent' : 'text-fg-2 hover:text-fg-1 hover:bg-surface-3'
      } ${className}`}
      {...rest}
    />
  );
  return typeof helpId === 'string' ? <Tooltip id={helpId}>{btn}</Tooltip> : btn;
};
