// A keyframe's icon, split down the middle the way After Effects draws one: the LEFT half is how the
// value ARRIVES (the previous key's curve), the RIGHT half how it LEAVES (this key's own curve). A
// key's `curve` shapes the segment that STARTS at it, so a single shape per key would only ever tell
// half the story — the half-icon is what makes "the ease ends here" readable at a glance.
//
//   linear ◆ · hold ■ · ease ● (bezier and the in/out families) · overshoot ▷◁ (back, elastic, bounce)
//
// A side with no segment (before the first key, after the last) is drawn faint: there is no curve
// there, and a solid half would claim one.
//
// ONE component for all three places keys are drawn — the automation lane, the colour row and the
// lighting clip — so a key wearing one shape in a lane cannot wear another in a clip. It is pure
// drawing: pointer-events stay on the caller's hit box, which keeps every existing gesture where it is.
import React from 'react';
import type { CurveKind } from '../../types';
import { easeFamily, type EaseFamily } from './ease';

/** The RIGHT half of each shape in an s×s box, from top-centre round to bottom-centre (open). */
function halfPath(f: EaseFamily, s: number): string {
  const c = s / 2;
  switch (f) {
    case 'hold': { const i = s * 0.12; return `M${c},${i} L${s - i},${i} L${s - i},${s - i} L${c},${s - i}`; }
    case 'ease': return `M${c},0 A${c},${c} 0 0 1 ${c},${s}`;
    case 'overshoot': { const w = s * 0.16; return `M${c},${c - w} L${s},0 L${s},${s} L${c},${c + w}`; }
    default: return `M${c},0 L${s},${c} L${c},${s}`;
  }
}

interface Props {
  size: number;
  /** The previous key's curve — the segment arriving here. */
  inCurve?: CurveKind | string;
  /** This key's own curve — the segment leaving here. */
  outCurve?: CurveKind | string;
  hasIn: boolean;
  hasOut: boolean;
  fill: string;
  stroke: string;
  className?: string;
  style?: React.CSSProperties;
}

const KeyGlyphBase: React.FC<Props> = ({ size: s, inCurve, outCurve, hasIn, hasOut, fill, stroke, className, style }) => {
  const right = halfPath(easeFamily(outCurve), s);
  const left = halfPath(easeFamily(inCurve), s);
  // The left half is the right-half shape mirrored about the centre line.
  const mirror = `translate(${s},0) scale(-1,1)`;
  return (
    <svg width={s} height={s} viewBox={`-0.5 -0.5 ${s + 1} ${s + 1}`} className={`overflow-visible pointer-events-none ${className ?? ''}`} style={style} aria-hidden>
      <g transform={mirror} opacity={hasIn ? 1 : 0.35}>
        <path d={`${left} Z`} fill={fill} />
        <path d={left} fill="none" stroke={stroke} strokeWidth={1} strokeLinejoin="round" />
      </g>
      <g opacity={hasOut ? 1 : 0.35}>
        <path d={`${right} Z`} fill={fill} />
        <path d={right} fill="none" stroke={stroke} strokeWidth={1} strokeLinejoin="round" />
      </g>
    </svg>
  );
};

export const KeyGlyph = React.memo(KeyGlyphBase);
