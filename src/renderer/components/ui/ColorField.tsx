import React, { useId } from 'react';

// A COLOUR, pickable and typable.
//
// Until this existed the app had exactly one colour input anywhere — a bare `<input type="color">` in
// the shader plugin's parameter rows — so anything else that needed a colour had to hand-roll it, and
// the second one to do so would have drifted from the first. A swatch alone is also not quite enough
// for show work: an operator with a brand hex, or one matching a colour read off another tool, wants
// to TYPE it, and wants to see what is currently set without opening the OS picker.
//
// Deliberately NOT applied to the shader plugin's rows. That control is a swatch inside a dense
// parameter grid where the label is the parameter's own name and there is no room for a hex box; this
// is a labelled field for an inspector. They look similar and are not the same control.
//
// The native picker is the picker. An in-app HSV wheel is a real piece of work and buys nothing here:
// the OS one already has an eyedropper on both platforms this ships to.

interface Props {
  label: string;
  /** `#rrggbb`. Anything the native input rejects is still shown in the text box, so a half-typed
   *  value is not destroyed while it is being typed. */
  value: string;
  onChange: (v: string) => void;
  title?: string;
  disabled?: boolean;
}

/** `#rgb` and `#rrggbb` are valid; the swatch needs the long form. */
const toSwatch = (v: string): string => {
  const s = (v || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return '#000000';
};

export const ColorField: React.FC<Props> = ({ label, value, onChange, title, disabled }) => {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <label htmlFor={id} className="w-20 shrink-0 truncate text-fg-2" title={title}>{label}</label>
      <div className="flex flex-1 items-center gap-2">
        <input
          id={id}
          type="color"
          value={toSwatch(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="h-5 w-10 shrink-0 cursor-pointer rounded border border-line-1 bg-surface-0 disabled:opacity-40"
        />
        {/* NO `focus:outline-none` here. In a KIT primitive that kills the global :focus-visible ring
            for every consumer, and an accent border is not a substitute — it shows on mouse focus too
            and gives a keyboard user nothing. Guarded by verify:invariants.
            The text box is the authority on what the operator typed — the swatch coerces to 6 digits,
            and echoing that back mid-edit would fight anyone typing a short form. */}
        <input
          type="text"
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="num min-w-0 flex-1 rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-micro text-fg-1 focus:border-accent disabled:opacity-40"
        />
      </div>
    </div>
  );
};
