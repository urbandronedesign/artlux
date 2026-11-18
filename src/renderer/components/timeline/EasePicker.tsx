// The ease picker: every curve kind as a PICTURE of itself. It replaces the <select> of names
// (CurveOptions) in all three editors that pick an ease — the automation keyframe editor, the colour
// key panel and the lighting inspector — because "easeInOutQuart" is a word you have to already know
// the shape of, and thirty of them in a dropdown is a list you read rather than choose from.
//
// · Each cell is drawn by `easePath`, i.e. sampled through the engine's own `segmentEase`, so the
//   thumbnail is the curve that plays. The faint lines mark 0 and 1, so back/elastic overshoot reads.
// · `onPreview` fires on hover: the automation lane draws the hovered ease on its real curve as a
//   draft (nothing is committed until a click). Colour and lighting have no such preview path; for
//   them hover only highlights.
// · Portalled and placed from a measured rect (usePopoverAnchor) like every popover in this
//   directory — it opens from inside other portalled panels, under the ruler's stacking context.
// · OPEN CAN BE CONTROLLED. The lighting inspector's Ease row is opened by the E shortcut from
//   Timeline, which owns the selected lighting key; the two other editors leave it uncontrolled.
import React, { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { CurveKind } from '../../types';
import { EASE_DIRECTIONS, EASE_FAMILIES, EASE_NAMES, easeGuides, easeLabel, easePath } from './ease';
import { usePopoverAnchor } from './usePopoverAnchor';

type Bez = { cx1?: number; cy1?: number; cx2?: number; cy2?: number };

const CW = 34, CH = 22;      // a grid cell's thumbnail
const PANEL_W = 176;         // must match w-44 below

const Thumb: React.FC<{ curve: string; w: number; h: number; bez?: Bez }> = ({ curve, w, h, bez }) => {
  const g = easeGuides(h);
  return (
    <svg width={w} height={h} className="pointer-events-none shrink-0" aria-hidden>
      <line x1={0} x2={w} y1={g.y0} y2={g.y0} className="stroke-line-1/60" strokeWidth={1} />
      <line x1={0} x2={w} y1={g.y1} y2={g.y1} className="stroke-line-1/60" strokeWidth={1} />
      <path d={easePath(curve, w, h, 2, bez)} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" />
    </svg>
  );
};

interface Props {
  /** The current ease. `null` = MIXED: several keys selected with different eases (none is marked). */
  value: CurveKind | undefined | null;
  onChange: (curve: CurveKind) => void;
  /** Hovered ease (or null when the hover ends / the picker closes) — for a live preview. */
  onPreview?: (curve: CurveKind | null) => void;
  /** The key's own handles, so the bezier cell shows the shape it will keep. */
  bez?: Bez;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  title?: string;
  /** Anchor the panel to this element and render NO trigger button — the multi-key picker Timeline
   *  opens from E has no field to sit in, so it is placed at the selected key instead. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** A line above the grid, e.g. "5 keys". */
  header?: string;
}

export const EasePicker: React.FC<Props> = ({ value, onChange, onPreview, bez, open, onOpenChange, className, title, anchorRef, header }) => {
  const [inner, setInner] = useState(false);
  const isOpen = open ?? inner;
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const cur: string | null = value === null ? null : (value ?? 'linear');

  const setOpen = (o: boolean) => {
    if (open === undefined) setInner(o);
    onOpenChange?.(o);
    if (!o) onPreview?.(null);
  };
  const pos = usePopoverAnchor(isOpen, anchorRef ?? btnRef, { width: PANEL_W, estHeight: 380, boxRef, onDismiss: () => setOpen(false) });

  // Opened from the keyboard (E) there is no pointer over the grid — put focus on the current ease so
  // Tab / Enter work from where you already are.
  useEffect(() => { if (isOpen && pos) currentRef.current?.focus({ preventScroll: true }); }, [isOpen, !!pos]);

  // A preview must never outlive the picker. Its parent panel can close under it (Escape reaches both,
  // a key deleted from under the editor unmounts it) without passing through setOpen(false), and a
  // draft left behind would keep drawing an ease nobody chose.
  const previewRef = useRef(onPreview); previewRef.current = onPreview;
  const openRef = useRef(isOpen); openRef.current = isOpen;
  useEffect(() => () => { if (openRef.current) previewRef.current?.(null); }, []);

  const pick = (c: CurveKind) => { onChange(c); setOpen(false); };

  const cell = (c: CurveKind, w = CW, h = CH) => {
    const on = c === cur;
    return (
      <button key={c} ref={on ? currentRef : undefined}
        onClick={() => pick(c)}
        onMouseEnter={() => onPreview?.(c)}
        onFocus={() => onPreview?.(c)}
        title={easeLabel(c)}
        className={`flex items-center justify-center rounded-sm border p-px outline-none focus-visible:border-accent ${on ? 'border-accent bg-accent/15 text-accent' : 'border-transparent text-fg-2 hover:text-fg-1 hover:border-line-2'}`}>
        <Thumb curve={c} w={w} h={h} bez={c === 'bezier' ? bez : undefined} />
      </button>
    );
  };

  return (
    <>
      {!anchorRef && (
        <button ref={btnRef} type="button" onClick={() => setOpen(!isOpen)} title={title ?? 'Choose the ease of the segment that starts at this key'}
          className={`flex items-center gap-1.5 text-left ${className ?? ''}`}>
          {cur !== null && <span className="text-accent"><Thumb curve={cur} w={22} h={14} bez={bez} /></span>}
          <span className="truncate">{cur === null ? 'mixed' : easeLabel(cur)}</span>
        </button>
      )}
      {isOpen && createPortal(
        <>
          {/* Backdrop first, box second — same tier, DOM order decides. Both stop the event: this
              portal's React parent is a lane body that SEEKS on pointerdown. */}
          <div className="fixed inset-0 z-popover" onPointerDown={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div ref={boxRef}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            // Enter on a cell must pick THAT cell, not reach the keyframe editor's Enter-commits handler.
            onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
            onMouseLeave={() => onPreview?.(null)}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="fixed z-popover w-44 p-1.5 rounded border border-line-2 bg-surface-0 shadow-e3 text-micro text-fg-3">
            {header && <div className="px-0.5 pb-1 mb-1 border-b border-line-1 text-fg-2">{header}</div>}
            <div className="grid grid-cols-3 gap-0.5 mb-1">
              {(['linear', 'hold', 'bezier'] as CurveKind[]).map((c) => (
                <div key={c} className="flex flex-col items-center">
                  {cell(c, 44, CH)}
                  <span className="leading-tight">{c}</span>
                </div>
              ))}
            </div>
            <div className="grid gap-0.5 items-center" style={{ gridTemplateColumns: `36px repeat(3, ${CW + 4}px)` }}>
              <span />
              {EASE_DIRECTIONS.map((d) => <span key={d.prefix} className="text-center leading-tight" title={d.hint}>{d.short}</span>)}
              {EASE_FAMILIES.map((f) => (
                <React.Fragment key={f}>
                  <span className="truncate">{f.toLowerCase()}</span>
                  {EASE_DIRECTIONS.map((d) => {
                    const name = `${d.prefix}${f}` as CurveKind;
                    return EASE_NAMES.includes(name as never) ? cell(name) : <span key={name} />;
                  })}
                </React.Fragment>
              ))}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
