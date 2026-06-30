import React from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { VideoClip, isContentClip } from '../../types';
import { Filmstrip } from './Filmstrip';
import { BlobSparkline } from './BlobSparkline';
import { fmtClock } from './geometry';

export type DragMode = 'move' | 'l' | 'r';

interface Props {
  clip: VideoClip;
  selected: boolean;
  locked: boolean;
  tool: 'select' | 'blade';
  pxPerSec: number;
  laneH: number;
  conflict?: boolean; // a live receiver (Spout/NDI) is contested by another overlapping clip
  onStartDrag: (e: React.PointerEvent, clip: VideoClip, mode: DragMode) => void;
  onBlade: (clip: VideoClip, clientX: number) => void;
  onRemove: (clipId: string) => void;
}

// A single clip on a lane. Memoized so an unrelated state change in the App tree doesn't repaint
// every clip — only clips whose inputs actually change re-render (key for perf in this no-memo app).
const ClipBlockBase: React.FC<Props> = ({ clip, selected, locked, tool, pxPerSec, laneH, conflict, onStartDrag, onBlade, onRemove }) => {
  const widthPx = Math.max(6, clip.duration * pxPerSec);
  const blade = tool === 'blade' && !locked;

  const onDown = (e: React.PointerEvent) => {
    if (blade) { e.stopPropagation(); e.preventDefault(); onBlade(clip, e.clientX); return; }
    if (locked) return;
    onStartDrag(e, clip, 'move');
  };

  return (
    <div
      onPointerDown={onDown}
      className={`absolute top-1 bottom-1 rounded-[var(--r-sm)] border overflow-hidden ${blade ? 'cursor-col-resize' : locked ? 'cursor-not-allowed' : 'cursor-grab'} ${selected ? 'border-accent bg-accent/20' : 'border-line-2 bg-surface-3'}`}
      style={{ left: clip.start * pxPerSec, width: widthPx, borderLeftColor: clip.color, borderLeftWidth: clip.color ? 3 : undefined }}
      title={`${clip.name} — ${fmtClock(clip.duration)}`}
    >
      {widthPx > 18 && (clip.kind === 'tracking'
        ? <BlobSparkline path={clip.path} inPoint={clip.inPoint} clipDuration={clip.duration} widthPx={widthPx} heightPx={laneH - 8} />
        : isContentClip(clip)
          ? <div className="absolute inset-0 flex items-center justify-center text-[9px] uppercase tracking-wider text-fg-3 bg-surface-2/40 pointer-events-none">{clip.content!.type === 'EFFECT' ? 'EFFECT' : clip.content!.type}</div>
          : <Filmstrip path={clip.path} inPoint={clip.inPoint} clipDuration={clip.duration} widthPx={widthPx} heightPx={laneH - 8} />)}
      <div className="absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-black/55 to-transparent pointer-events-none" />
      <div className="relative px-1.5 pt-0.5 text-[10px] leading-tight truncate text-fg-1 pointer-events-none drop-shadow">{clip.name}</div>
      {conflict && <div title="Another clip/surface is using this live input — the last one under the playhead wins" className="absolute bottom-0.5 left-1 text-warn pointer-events-none"><AlertTriangle size={10} /></div>}
      {!blade && !locked && <>
        <div onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, clip, 'l'); }} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
        <div onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, clip, 'r'); }} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
      </>}
      {selected && !locked && (
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(clip.id)} className="absolute top-0.5 right-2 text-fg-2 hover:text-danger"><Trash2 size={10} /></button>
      )}
    </div>
  );
};

export const ClipBlock = React.memo(ClipBlockBase);
