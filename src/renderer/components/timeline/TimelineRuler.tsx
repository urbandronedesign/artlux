import React, { useState } from 'react';
import { Marker } from '../../types';
import { chooseTickStep, fmtTimecode } from './geometry';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

interface Props {
  pxPerSec: number;
  width: number;
  height: number;
  fps: number;
  markers: Marker[];
  // The HANDLES sit on the raw authored points (so a degenerate one can still be grabbed and dragged
  // back), while the shaded BAND spans the range the engine will actually play — which Timeline.tsx
  // resolves through timelineStart/timelineEnd, because either point alone is a valid region and a
  // degenerate one is ignored. null/null ⇒ no region ⇒ no band.
  inPoint: number | null;
  outPoint: number | null;
  bandStart: number | null;
  bandEnd: number | null;
  // Content authored past the document's LENGTH (Timeline.tsx's `overrunAt`, banded from `lengthEnd`). An
  // audio clip does not extend Length, and a video clip past a deliberately-short Length is honoured as
  // authored — so either way this content will never be heard or seen. Both null ⇒ nothing overruns ⇒ no
  // band.
  //
  // NOT banded from the playable end: an out-point overrides Length, and hatching a deliberately narrowed
  // LOOP REGION as if it were broken content is a false alarm on a normal authoring workflow.
  overrunFrom: number | null;
  overrunTo: number | null;
  // Timeline.holdAtEnd — the end is where the STATE ENDS and freezes, not merely where playback stops.
  // Marks the out-handle, because that one authored point now means two quite different things and an
  // operator has to be able to see which from the ruler.
  holdAtEnd: boolean;
  onSeekDown: (e: React.PointerEvent) => void;
  onMarkerSeek: (time: number) => void;
  onMarkerDelete: (id: string) => void;
  onMarkerNote: (id: string, note: string) => void;
  // Region-handle grab. Deliberately just a pointerdown forward — Timeline.tsx owns the whole drag
  // (window listeners, snapping, draft state, commit-on-up), same as onSeekDown above. The ruler
  // itself carries no time math beyond px→sec for layout and stays pure props-in.
  onMoveInDown: (e: React.PointerEvent) => void;
  onMoveOutDown: (e: React.PointerEvent) => void;
}

const shortTc = (t: number, fps: number) => {
  const s = fmtTimecode(t, fps);
  return s.startsWith('00:') ? s.slice(3) : s;
};

// MEMOIZED, AND IT MATTERS MORE THAN IT LOOKS. This component renders one tick element per step across
// the FULL rendered width, and the timeline is unbounded — the width grows in pages as the playhead
// advances — so it is the largest DOM producer in the panel. Measured during a clip drag it was **170 ms
// of the panel's 341 ms**, half the cost of the gesture, and not one of its props changes while a clip
// moves. Timeline.tsx keeps its handlers and its `markers` array referentially stable so this compare can
// actually bail out; break either and the memo silently becomes a compare that always fails.
const TimelineRulerBase: React.FC<Props> = ({ pxPerSec, width, height, fps, markers, inPoint, outPoint, bandStart, bandEnd, overrunFrom, overrunTo, holdAtEnd, onSeekDown, onMarkerSeek, onMarkerDelete, onMarkerNote, onMoveInDown, onMoveOutDown }) => {
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const step = chooseTickStep(pxPerSec);
  const ticks: number[] = [];
  const maxT = width / pxPerSec; // infinite timeline: ticks span the rendered (growing) width
  for (let t = 0; t <= maxT + 1e-6; t += step) ticks.push(t);

  return (
    <div className="relative bg-surface-1/60 cursor-text border-b border-line-1" style={{ height, width }} onPointerDown={onSeekDown}>
      {/* the playable range — shaded. Either point alone produces one (see Props). */}
      {bandStart != null && bandEnd != null && bandEnd > bandStart && (
        <div className="absolute top-0 bottom-0 bg-accent/15 border-x border-accent/60 pointer-events-none" style={{ left: bandStart * pxPerSec, width: (bandEnd - bandStart) * pxPerSec }} />
      )}
      {/* Content past the END — authored but unplayable. Distinct from the playable band above, and never
          a pointer target: the fix is the one-click badge in the toolbar, not a drag. */}
      {overrunFrom != null && overrunTo != null && overrunTo > overrunFrom && (
        <div className="absolute top-0 bottom-0 bg-warn/10 border-l border-warn/50 pointer-events-none"
          style={{ left: overrunFrom * pxPerSec, width: (overrunTo - overrunFrom) * pxPerSec }} />
      )}
      {/* handles: 8px hit area (w-2 -ml-1), the line itself stays 2px — a 2px target is unusable */}
      {inPoint != null && (
        <Tooltip id="timeline.region-in">
        <div onPointerDown={onMoveInDown} {...help('timeline.region-in')} title="In — drag to move"
          className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 flex justify-center group"
          style={{ left: inPoint * pxPerSec }}>
          <div className="w-0.5 h-full bg-accent group-hover:w-1 transition-[width]" />
        </div>
        </Tooltip>
      )}
      {outPoint != null && (
        <Tooltip id="timeline.region-out">
        <div onPointerDown={onMoveOutDown} {...help('timeline.region-out')}
          title={holdAtEnd ? 'State end — the picture freezes here and the show plays on. Drag to move.' : 'Out — drag to move'}
          className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 flex justify-center group"
          style={{ left: outPoint * pxPerSec }}>
          <div className={`w-0.5 h-full group-hover:w-1 transition-[width] ${holdAtEnd ? 'bg-warn' : 'bg-accent'}`} />
          {/* A HOLD reads differently from a stop and must LOOK different: the state ends here and the
              last frame stays on the wall. One dot on the handle, no extra hit area (the handle's own
              8px target must not be split by a child that swallows the pointerdown). */}
          {holdAtEnd && <div className="absolute top-0.5 w-1.5 h-1.5 rounded-full bg-warn pointer-events-none" />}
        </div>
        </Tooltip>
      )}

      {ticks.map((t, i) => (
        <div key={i} className="absolute top-0 bottom-0 border-l border-line-1/60 pointer-events-none" style={{ left: t * pxPerSec }}>
          <span className="absolute top-1 left-1 num text-micro text-fg-3 whitespace-nowrap">{shortTc(t, fps)}</span>
        </div>
      ))}

      {/* markers */}
      {markers.map(m => (
        <Tooltip key={m.id} id="timeline.marker">
        <div
          className="absolute -bottom-px z-10 group"
          style={{ left: m.time * pxPerSec }}
          {...help('timeline.marker')}
          title={m.note || 'Marker (Alt-click to delete, double-click to edit)'}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.altKey || e.button === 2) { onMarkerDelete(m.id); return; }
            onMarkerSeek(m.time);
          }}
          onDoubleClick={(e) => { e.stopPropagation(); setEditing({ id: m.id, note: m.note ?? '' }); }}
          onContextMenu={(e) => { e.preventDefault(); onMarkerDelete(m.id); }}
        >
          <div className="w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent -ml-[5px] cursor-pointer" style={{ borderTopColor: m.color }} />
        </div>
        </Tooltip>
      ))}

      {editing && (
        <input
          autoFocus
          value={editing.note}
          onChange={(e) => setEditing({ ...editing, note: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={() => { onMarkerNote(editing.id, editing.note); setEditing(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { onMarkerNote(editing.id, editing.note); setEditing(null); } if (e.key === 'Escape') setEditing(null); }}
          placeholder="Marker note…"
          className="absolute top-0 z-20 w-40 bg-surface-0 border border-accent rounded px-1 text-micro text-fg-1 outline-none"
          style={{ left: (markers.find(m => m.id === editing.id)?.time ?? 0) * pxPerSec }}
        />
      )}
    </div>
  );
};
export const TimelineRuler = React.memo(TimelineRulerBase);
