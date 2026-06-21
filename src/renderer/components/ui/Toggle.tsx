import React from 'react';

interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
}

export const Toggle: React.FC<Props> = ({ label, checked, onChange, title }) => (
  <div className="flex items-center justify-between" title={title}>
    <span className="text-xs text-fg-2">{label}</span>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="bg-surface-0 border-line-2 rounded text-accent focus:ring-0 cursor-pointer"
    />
  </div>
);
