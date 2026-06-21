import React from 'react';

// Label + control row used throughout the inspector.
export const Field: React.FC<{ label: string; children: React.ReactNode; labelWidth?: string }> = ({
  label,
  children,
  labelWidth = 'w-16',
}) => (
  <div className="flex items-center justify-between text-xs gap-2">
    <label className={`text-fg-2 ${labelWidth} truncate`}>{label}</label>
    {children}
  </div>
);
