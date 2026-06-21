import React from 'react';
import { Field } from './Field';

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
}

export const NumberField: React.FC<Props> = ({ label, value, onChange, step = 1, min, max }) => (
  <Field label={label}>
    <input
      type="number"
      step={step}
      min={min}
      max={max}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="num flex-1 bg-surface-0 border border-line-1 rounded-[var(--r-sm)] px-1.5 py-1 text-right text-fg-1 focus:border-accent focus:outline-none"
    />
  </Field>
);
