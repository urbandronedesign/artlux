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

/**
 * THE NUMERIC INPUT THAT NEVER COMMITS NaN — bare, so it can sit in a labelled row (NumberField) or
 * three-to-a-row in a vector (VectorField) without either of them re-implementing the guard.
 *
 * `parseFloat('')` is NaN, and clearing the field to retype is a normal step — the old
 * `onChange(parseFloat(value))` shipped that NaN straight into project state (ledCount, fps,
 * watchdog thresholds, and every 3D position in the inspector), where `Math.max(1, Math.round(NaN))`
 * is still NaN and then `value={NaN}` desynced the controlled input. So: hold a local draft string
 * while editing, only propagate FINITE values, and snap the draft back to the model value on blur if
 * it is junk.
 *
 * It is EXPORTED because it was extracted, not invented: there was a second, unguarded copy of this
 * control living in the inspector, used at 33 sites. One owner, or the guard is only true in the
 * places somebody remembered.
 */
export const NumInput: React.FC<{
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  id?: string;
  className?: string;
  title?: string;
}> = ({ value, onChange, step = 1, min, max, id, className, title }) => {
  const [draft, setDraft] = React.useState<string>(String(value));
  const [editing, setEditing] = React.useState(false);

  // Keep the visible text in sync with the model whenever the field isn't being actively edited
  // (an external change — undo, a linked control, a gizmo drag, a preset load — must show through).
  React.useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  return (
    <input
      id={id}
      title={title}
      type="number"
      step={step}
      min={min}
      max={max}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => {
        const raw = e.target.value;
        setDraft(raw);
        const n = parseFloat(raw);
        if (Number.isFinite(n)) onChange(n); // empty / '-' / '1.' → keep the last good value
      }}
      onBlur={() => {
        setEditing(false);
        const n = parseFloat(draft);
        if (Number.isFinite(n)) { onChange(n); setDraft(String(n)); }
        else setDraft(String(value)); // junk → restore the model value
      }}
      className={className ?? 'num flex-1 bg-surface-0 border border-line-1 rounded-sm px-1.5 py-1 text-right text-fg-1 focus:border-accent'}
    />
  );
};

/** A labelled numeric row — the ordinary inspector field. */
export const NumberField: React.FC<Props> = ({ label, value, onChange, step = 1, min, max, labelWidth }) => (
  <Field label={label} labelWidth={labelWidth}>
    <NumInput value={value} onChange={onChange} step={step} min={min} max={max} />
  </Field>
);
