// The <option>s of a curve-kind <select>: linear, hold, bezier, then the named eases grouped by
// direction. ONE list because three editors pick a curve kind — the automation keyframe editor, the
// colour key and the lighting key — and a kind offered in one and missing from another reads as the
// other two being broken. The names come from EASE_FN's own keys, so the menu cannot offer an ease the
// sampler does not have.
import React from 'react';
import { EASE_FN } from '../../services/automation';

const NAMES = Object.keys(EASE_FN);
const FAMILIES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo', 'Circ', 'Back', 'Elastic', 'Bounce'];
const GROUPS: Array<{ label: string; prefix: string }> = [
  { label: 'Ease in — starts slowly', prefix: 'easeIn' },
  { label: 'Ease out — arrives slowly', prefix: 'easeOut' },
  { label: 'Ease in-out', prefix: 'easeInOut' },
];

export const CurveOptions: React.FC = () => (
  <>
    <option value="linear">linear</option>
    <option value="hold">hold</option>
    <option value="bezier">bezier</option>
    {GROUPS.map((g) => (
      <optgroup key={g.prefix} label={g.label}>
        {FAMILIES.filter((f) => NAMES.includes(g.prefix + f)).map((f) => (
          <option key={f} value={g.prefix + f}>{f.toLowerCase()}</option>
        ))}
      </optgroup>
    ))}
  </>
);
