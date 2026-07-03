import React, { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  value: number;
  /** Committed once, on pointer/key release — keeps app state (and re-renders) off the drag path. */
  onChange: (v: number) => void;
  /** Optional live callback fired on every drag tick, for render-free imperative previews. */
  onInput?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  /** Optional CSS background for the track (e.g. an R/G/B gradient). */
  trackGradient?: string;
}

/**
 * Range slider that drives a local value during the drag (so the thumb + readout stay
 * smooth) and only commits to React state on release. Pass `onInput` to drive a live,
 * render-free preview (e.g. master brightness) while dragging.
 */
export const Slider: React.FC<Props> = ({ label, value, onChange, onInput, min = 0, max = 1, step = 0.01, format, trackGradient }) => {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);

  // Follow external changes (scene recall, project load) only when not actively dragging.
  useEffect(() => { if (!dragging.current) setLocal(value); }, [value]);

  const commit = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (local !== value) onChange(local);
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <label className="text-fg-2">{label}</label>
        <span className="num text-micro text-fg-1">{format ? format(local) : local}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          dragging.current = true;
          setLocal(v);
          onInput?.(v);
        }}
        onPointerUp={commit}
        onPointerCancel={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="w-full"
        style={trackGradient ? { background: trackGradient, height: 4, borderRadius: 2 } : undefined}
      />
    </div>
  );
};
