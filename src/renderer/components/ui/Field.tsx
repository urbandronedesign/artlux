import React from 'react';

// Label + control row used throughout the inspector. The visible <label> is now ASSOCIATED with its
// control (htmlFor ↔ id): clicking the label focuses the input, and a screen reader announces the field
// name. Field injects a generated id onto its single child (unless the child already has one), so
// NumberField's <input> and a Select-in-Field are both covered with no per-call change.
export const Field: React.FC<{ label: string; children: React.ReactNode; labelWidth?: string }> = ({
  label,
  children,
  labelWidth = 'w-16',
}) => {
  const generated = React.useId();
  const child = React.isValidElement(children) ? (children as React.ReactElement<{ id?: string }>) : null;
  const controlId = child?.props.id ?? generated;
  const linked = child ? React.cloneElement(child, { id: controlId }) : children;
  return (
    <div className="flex items-center justify-between text-xs gap-2">
      <label htmlFor={controlId} className={`text-fg-2 ${labelWidth} truncate`}>{label}</label>
      {linked}
    </div>
  );
};
