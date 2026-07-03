import React, { useEffect, useRef, useState } from 'react';
import { Circle, Square, Plus, Trash2, Radio } from 'lucide-react';
import { TrackingTakeRef } from '../../types';
import { trackingRecorder as recorder } from '@artlux/plugin-lidar-tracking';
import { fmtClock } from './geometry';

interface Props {
  takes: TrackingTakeRef[];
  hasTrackingLane: boolean;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onAddTrackingLane: () => void;
  onRemoveTake: (id: string) => void;
}

// Recorded LiDAR-blob take library. Record captures the live blob stream (independent of the
// transport); finished takes appear here as draggable chips — drop one onto a tracking lane to
// place it as a clip. A horizontal strip under the timeline toolbar.
export const TakesBin: React.FC<Props> = ({ takes, hasTrackingLane, onStartRecord, onStopRecord, onAddTrackingLane, onRemoveTake }) => {
  const [recording, setRecording] = useState(recorder.isRecording());
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => recorder.subscribe(() => setRecording(recorder.isRecording())), []);
  useEffect(() => {
    if (recording) {
      const tick = () => setElapsed(recorder.getElapsed());
      timerRef.current = window.setInterval(tick, 200); tick();
      return () => { if (timerRef.current) window.clearInterval(timerRef.current); };
    }
    setElapsed(0);
  }, [recording]);

  const onDragStart = (e: React.DragEvent, t: TrackingTakeRef) => {
    e.dataTransfer.setData('application/artlux-take', t.id);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div className="flex items-center gap-2 px-2 py-1 border-b border-line-1 bg-surface-1/60 text-mini overflow-x-auto">
      <button
        onClick={recording ? onStopRecord : onStartRecord}
        title={recording ? 'Stop recording' : 'Record the live LiDAR blob feed into a take'}
        className={`inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border ${recording ? 'bg-danger text-black border-transparent animate-pulse' : 'bg-surface-2 text-fg-1 border-line-1 hover:bg-surface-3'}`}
      >
        {recording ? <Square size={11} /> : <Circle size={11} className="text-danger fill-danger" />}
        {recording ? `REC ${fmtClock(elapsed)}` : 'Record'}
      </button>

      {!hasTrackingLane && (
        <button onClick={onAddTrackingLane} title="Add a tracking lane to place takes on"
          className="inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 hover:bg-surface-3">
          <Plus size={11} /> Tracking lane
        </button>
      )}

      <span className="inline-flex items-center gap-1 text-fg-3 shrink-0"><Radio size={11} /> Takes</span>
      {takes.length === 0 && <span className="text-fg-3 italic shrink-0">none yet — record the tracker feed</span>}
      {takes.map(t => (
        <div key={t.id} draggable onDragStart={(e) => onDragStart(e, t)}
          title={`${t.name} — ${fmtClock(t.duration)} · drag onto the tracking lane`}
          className="group inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border border-line-2 bg-surface-3 cursor-grab hover:border-accent">
          <span className="truncate max-w-[120px] text-fg-1">{t.name}</span>
          <span className="text-fg-3">{fmtClock(t.duration)}</span>
          <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemoveTake(t.id)}
            className="text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100"><Trash2 size={10} /></button>
        </div>
      ))}
    </div>
  );
};
