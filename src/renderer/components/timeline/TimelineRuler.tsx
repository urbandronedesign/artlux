import React, { useState } from 'react';
import { Marker } from '../../types';
import { chooseTickStep, fmtTimecode } from './geometry';

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
  // Content authored PAST the end of playback (Timeline.tsx's `overrunAt`). An audio clip does not extend
  // Length, and a video clip past a deliberately-short Length is honoured as authored — so either way this
  // content will never be heard or seen. Both null ⇒ nothing overruns ⇒ no band.
  overrunFrom: number | null;
  overrunTo: number | null;
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

export const TimelineRuler: React.FC<Props> = ({ pxPerSec, width, height, fps, markers, inPoint, outPoint, bandStart, bandEnd, overrunFrom, overrunTo, onSeekDown, onMarkerSeek, onMarkerDelete, onMarkerNote, onMoveInDown, onMoveOutDown }) => {
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
        <div onPointerDown={onMoveInDown} title="In — drag to move"
          className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 flex justify-center group"
          style={{ left: inPoint * pxPerSec }}>
          <div className="w-0.5 h-full bg-accent group-hover:w-1 transition-[width]" />
        </div>
      )}
      {outPoint != null && (
        <div onPointerDown={onMoveOutDown} title="Out — drag to move"
          className="absolute top-0 bottom-0 w-2 -ml-1 cursor-ew-resize z-10 flex justify-center group"
          style={{ left: outPoint * pxPerSec }}>
          <div className="w-0.5 h-full bg-accent group-hover:w-1 transition-[width]" />
        </div>
      )}

      {ticks.map((t, i) => (
        <div key={i} className="absolute top-0 bottom-0 border-l border-line-1/60 pointer-events-none" style={{ left: t * pxPerSec }}>
          <span className="absolute top-1 left-1 num text-micro text-fg-3 whitespace-nowrap">{shortTc(t, fps)}</span>
        </div>
      ))}

      {/* markers */}
      {markers.map(m => (
        <div
          key={m.id}
          className="absolute -bottom-px z-10 group"
          style={{ left: m.time * pxPerSec }}
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
