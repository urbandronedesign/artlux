import React from 'react';
import { NumInput } from './NumberField';

/**
 * A VECTOR ON ONE ROW — "Position  [X …][Y …][Z …]" instead of three stacked labelled fields.
 *
 * WHY IT EXISTS. The inspector for a pixel fixture stacks Patch, Mapping, Segments, 2D / Output,
 * Routing, 3D Layout and Arrange, and 3D Layout alone spent NINE full-width rows on Position,
 * Rotation and Scale — three numbers each, every one of them a row of its own with a label column
 * repeating X, Y, Z. At ~38px a row that is well over 200px of a column an operator then has to
 * scroll, to show nine numbers that belong to three things.
 *
 * Grouping them is also more honest about what they ARE: a position is one property with three
 * components, not three properties that happen to be adjacent. Every 3D tool in the category draws
 * them this way for that reason.
 *
 * The axis letter sits INSIDE each field rather than above it, so the row costs exactly one line and
 * the numbers stay right-aligned and comparable down the column.
 *
 * ⚠ The input is `NumInput`, the same NaN-safe control NumberField uses. It is not a detail: the
 * inspector's own numeric input committed `parseFloat('')` — NaN — straight into project state, so
 * clearing a Position field to retype it wrote NaN into `position3D`. Anything that takes a number
 * here goes through one guarded input.
 */
export interface VectorAxis {
  /** The letter shown in the field — X / Y / Z, or P / Y / R for an orientation. */
  key: string;
  value: number;
  onChange: (v: number) => void;
  /** Long name for the tooltip, when the letter alone is not obvious ("Pitch"). */
  title?: string;
}

export const VectorField: React.FC<{
  label: string;
  axes: VectorAxis[];
  step?: number;
  min?: number;
  /** Shown after the label — "m", "°", "×" — so the row still says what the numbers mean. */
  unit?: string;
  labelWidth?: string;
}> = ({ label, axes, step = 0.05, min, unit, labelWidth = 'w-16' }) => (
  <div className="flex items-center gap-1.5 text-xs">
    <label className={`text-fg-2 ${labelWidth} shrink-0 truncate`} title={unit ? `${label} (${unit})` : label}>
      {label}{unit && <span className="text-fg-3"> {unit}</span>}
    </label>
    <div className="flex-1 min-w-0 flex gap-1">
      {axes.map((a) => (
        <div key={a.key} className="relative flex-1 min-w-0" title={a.title ?? a.key}>
          {/* pointer-events-none so the letter never eats a click meant for the field it labels. */}
          <span className="absolute left-1 top-1/2 -translate-y-1/2 text-micro text-fg-3 pointer-events-none select-none">
            {a.key}
          </span>
          <NumInput
            value={a.value}
            onChange={a.onChange}
            step={step}
            min={min}
            // No focus:outline-none — the kit keeps the browser ring and adds the accent border on top,
            // and suppressing it here would make a keyboard user lose the field they are in. Guarded.
            className="num w-full bg-surface-0 border border-line-1 rounded-sm pl-4 pr-1 py-1 text-right text-fg-1 focus:border-accent"
          />
        </div>
      ))}
    </div>
  </div>
);
