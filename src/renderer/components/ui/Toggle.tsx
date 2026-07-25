import React from 'react';

interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
}

// The whole row is a <label>, so clicking the TEXT toggles the box (it didn't before — only the ~13px
// checkbox itself was a target), and the label is programmatically associated with the input.
export const Toggle: React.FC<Props> = ({ label, checked, onChange, title }) => (
  <label className="flex items-center justify-between cursor-pointer pressable rounded-sm" title={title}>
    <span className="text-xs text-fg-2">{label}</span>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="bg-surface-0 border-line-2 rounded text-accent cursor-pointer"
    />
  </label>
);
