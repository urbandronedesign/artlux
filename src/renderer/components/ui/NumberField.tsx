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
  /**
   * WHEN THE VALUE REACHES THE DOCUMENT.
   *
   * `'live'` (default) applies every finite keystroke, so a slider-ish field and its target move
   * together as you type — what the inspector has always done.
   *
   * `'blur'` holds the text until you leave the field or press Enter, and Escape abandons it. The 3D
   * scene panel wants this: its fields drive geometry in a live viewport, and applying `5`, then
   * `52`, then `523` on the way to typing a position is three scene updates and three positions you
   * did not mean. It is a real difference in feel, which is why it is a named choice here rather
   * than one behaviour flattened onto the other when these two controls were merged.
   */
  commit?: 'live' | 'blur';
}> = ({ value, onChange, step = 1, min, max, id, className, title, commit = 'live' }) => {
  const [draft, setDraft] = React.useState<string>(String(value));
  const [editing, setEditing] = React.useState(false);

  // Keep the visible text in sync with the model whenever the field isn't being actively edited
  // (an external change — undo, a linked control, a gizmo drag, a preset load — must show through).
  React.useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  // ⚠ Number.isFinite, NOT !Number.isNaN. `parseFloat('')` is NaN and clearing a field to retype is
  // normal — but `parseFloat('1e400')` is **Infinity**, which is not NaN and would sail through the
  // looser test straight into project state. This repo has already been bitten by exactly that shape
  // once (see types.ts on a hand-edited `outPoint: 1e400`), and Infinity in a 3D position becomes NaN
  // matrices, which takes the geometry and its picking with it.
  //
  // `min` is CLAMPED here, which the 3D panel's input did and this one previously left to the HTML
  // attribute. Checked before merging rather than assumed: all 13 call sites that pass `min` already
  // clamp identically inside their own onChange, so the outcome is unchanged and the guard is simply
  // no longer optional.
  const apply = (raw: string): boolean => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return false;
    onChange(min != null ? Math.max(min, n) : n);
    return true;
  };

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
        setDraft(e.target.value);
        if (commit === 'live') apply(e.target.value);  // empty / '-' / '1.' → keep the last good value
      }}
      onKeyDown={(e) => {
        if (commit !== 'blur') return;
        // Enter commits by blurring (one path, so the commit rules cannot diverge); Escape abandons.
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') { setDraft(String(value)); setEditing(false); (e.target as HTMLInputElement).blur(); }
      }}
      onBlur={() => {
        setEditing(false);
        if (apply(draft)) setDraft(String(parseFloat(draft)));
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
