import React, { useState } from 'react';
import { Marker } from '../../types';
import { chooseTickStep, fmtTimecode } from './geometry';

interface Props {
  duration: number;
  pxPerSec: number;
  width: number;
  height: number;
  fps: number;
  markers: Marker[];
  inPoint: number | null;
  outPoint: number | null;
  onSeekDown: (e: React.PointerEvent) => void;
  onMarkerSeek: (time: number) => void;
  onMarkerDelete: (id: string) => void;
  onMarkerNote: (id: string, note: string) => void;
}

const shortTc = (t: number, fps: number) => {
  const s = fmtTimecode(t, fps);
  return s.startsWith('00:') ? s.slice(3) : s;
};

export const TimelineRuler: React.FC<Props> = ({ duration, pxPerSec, width, height, fps, markers, inPoint, outPoint, onSeekDown, onMarkerSeek, onMarkerDelete, onMarkerNote }) => {
  const [editing, setEditing] = useState<{ id: string; note: string } | null>(null);
  const step = chooseTickStep(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; t <= duration + 1e-6; t += step) ticks.push(t);

  return (
    <div className="relative bg-surface-1/60 cursor-text border-b border-line-1" style={{ height, width }} onPointerDown={onSeekDown}>
      {/* in/out range band */}
      {inPoint != null && outPoint != null && outPoint > inPoint && (
        <div className="absolute top-0 bottom-0 bg-accent/15 border-x border-accent/60 pointer-events-none" style={{ left: inPoint * pxPerSec, width: (outPoint - inPoint) * pxPerSec }} />
      )}
      {inPoint != null && <div className="absolute top-0 bottom-0 w-0.5 bg-accent pointer-events-none" style={{ left: inPoint * pxPerSec }} title="In" />}
      {outPoint != null && <div className="absolute top-0 bottom-0 w-0.5 bg-accent pointer-events-none" style={{ left: outPoint * pxPerSec }} title="Out" />}

      {ticks.map((t, i) => (
        <div key={i} className="absolute top-0 bottom-0 border-l border-line-1/60 pointer-events-none" style={{ left: t * pxPerSec }}>
          <span className="absolute top-1 left-1 num text-[9px] text-fg-3 whitespace-nowrap">{shortTc(t, fps)}</span>
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
          className="absolute top-0 z-20 w-40 bg-surface-0 border border-accent rounded px-1 text-[10px] text-fg-1 outline-none"
          style={{ left: (markers.find(m => m.id === editing.id)?.time ?? 0) * pxPerSec }}
        />
      )}
    </div>
  );
};
