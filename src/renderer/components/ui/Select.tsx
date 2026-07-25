import React from 'react';

interface Props extends React.SelectHTMLAttributes<HTMLSelectElement> {
  children: React.ReactNode;
}

export const Select: React.FC<Props> = ({ className = '', children, ...rest }) => (
  <select
    className={`flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-fg-1 focus:border-accent ${className}`}
    {...rest}
  >
    {children}
  </select>
);
