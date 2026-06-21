import React from 'react';

interface Props {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  /** Optional CSS background for the track (e.g. an R/G/B gradient). */
  trackGradient?: string;
}

export const Slider: React.FC<Props> = ({ label, value, onChange, min = 0, max = 1, step = 0.01, format, trackGradient }) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between text-xs">
      <label className="text-fg-2">{label}</label>
      <span className="num text-[10px] text-fg-1">{format ? format(value) : value}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      className="w-full"
      style={trackGradient ? { background: trackGradient, height: 4, borderRadius: 2 } : undefined}
    />
  </div>
);
