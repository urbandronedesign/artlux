import React from 'react';
import { Field } from './Field';

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  // Widen the label column where the container affords it (Preferences' tiles are ~2x an inspector
  // column, so 'Min relaunch gap (s)' need not read as 'Min relau…'). Defaults to Field's w-16.
  labelWidth?: string;
}

export const NumberField: React.FC<Props> = ({ label, value, onChange, step = 1, min, max, labelWidth }) => (
  <Field label={label} labelWidth={labelWidth}>
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
    />
  </Field>
);
