import React, { useEffect, useRef, useState } from 'react';
import { Circle, Square, Plus, Trash2, Radio, Lightbulb } from 'lucide-react';
import { TrackingTakeRef, type LightingTake } from '../../types';
import { trackingRecorder as recorder } from '@artlux/plugin-lidar-tracking';
import * as lightingRecorder from '../../services/lightingRecorder';
import { fmtClock } from './geometry';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

interface Props {
  takes: TrackingTakeRef[];
  hasTrackingLane: boolean;
  onStartRecord: () => void;
  onStopRecord: () => void;
  onAddTrackingLane: () => void;
  onRemoveTake: (id: string) => void;
  /** Lighting: the lane that carries fixture movement (see docs/LIGHTING-SHOW.md). */
  hasLightingLane?: boolean;
  onAddLightingLane?: () => void;
  lightingTakes?: LightingTake[];
  /** How many fixtures are selected — a recording captures exactly those, in selection order. */
  selectedFixtureCount?: number;
  onStartLightingRecord?: () => void;
  onStopLightingRecord?: () => void;
  onRemoveLightingTake?: (id: string) => void;
}

// Recorded LiDAR-blob take library. Record captures the live blob stream (independent of the
// transport); finished takes appear here as draggable chips — drop one onto a tracking lane to
// place it as a clip. A horizontal strip under the timeline toolbar.
export const TakesBin: React.FC<Props> = ({ takes, hasTrackingLane, onStartRecord, onStopRecord, onAddTrackingLane, onRemoveTake, hasLightingLane, onAddLightingLane,
  lightingTakes = [], selectedFixtureCount = 0, onStartLightingRecord, onStopLightingRecord, onRemoveLightingTake }) => {
  const [recording, setRecording] = useState(recorder.isRecording());
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => recorder.subscribe(() => setRecording(recorder.isRecording())), []);

  // The lighting recorder runs on its own clock (capture is independent of the transport), so it
  // gets its own indicator rather than sharing the tracking one.
  const [lightRec, setLightRec] = useState(lightingRecorder.isRecording());
  const [lightElapsed, setLightElapsed] = useState(0);
  useEffect(() => lightingRecorder.subscribe(() => setLightRec(lightingRecorder.isRecording())), []);
  useEffect(() => {
    if (!lightRec) { setLightElapsed(0); return; }
    const id = window.setInterval(() => setLightElapsed(lightingRecorder.getElapsed()), 200);
    return () => window.clearInterval(id);
  }, [lightRec]);
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
      <Tooltip id="timeline.take-record">
        <button
          onClick={recording ? onStopRecord : onStartRecord}
          title={recording ? 'Stop recording' : 'Record the live LiDAR blob feed into a take'}
          {...help('timeline.take-record')}
          className={`inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border ${recording ? 'bg-danger text-black border-transparent animate-pulse' : 'bg-surface-2 text-fg-1 border-line-1 hover:bg-surface-3'}`}
        >
          {recording ? <Square size={11} /> : <Circle size={11} className="text-danger fill-danger" />}
          {recording ? `REC ${fmtClock(elapsed)}` : 'Record'}
        </button>
      </Tooltip>

      {!hasTrackingLane && (
        <Tooltip id="timeline.take-add-lane">
          <button onClick={onAddTrackingLane} title="Add a tracking lane to place takes on"
            {...help('timeline.take-add-lane')}
            className="inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 hover:bg-surface-3">
            <Plus size={11} /> Tracking lane
          </button>
        </Tooltip>
      )}

      {!hasLightingLane && onAddLightingLane && (
        <Tooltip id="timeline.lighting-add-lane">
          <button onClick={onAddLightingLane} title="Add a lighting lane — movement instanced onto a fixture group"
            {...help('timeline.lighting-add-lane')}
            className="inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 hover:bg-surface-3">
            <Lightbulb size={11} /> Lighting lane
          </button>
        </Tooltip>
      )}

      {onStartLightingRecord && (
        <Tooltip id="timeline.lighting-record">
          <button
            onClick={lightRec ? onStopLightingRecord : onStartLightingRecord}
            disabled={!lightRec && selectedFixtureCount === 0}
            {...help('timeline.lighting-record')}
            title={selectedFixtureCount === 0 && !lightRec
              ? 'Select the fixtures to record first — their selection order becomes the take'
              : `Record the movement of ${selectedFixtureCount} selected fixture(s)`}
            className={`inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border ${lightRec ? 'border-danger text-danger' : 'border-line-1 bg-surface-2 text-fg-2 hover:text-fg-1 hover:bg-surface-3'} disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {lightRec ? <Square size={11} /> : <Lightbulb size={11} />}
            {lightRec ? `REC ${fmtClock(lightElapsed)}` : `Record move${selectedFixtureCount ? ` (${selectedFixtureCount})` : ''}`}
          </button>
        </Tooltip>
      )}

      {lightingTakes.map(t => (
        <Tooltip key={t.id} id="timeline.lighting-take-chip">
          <div
            className="inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border border-line-1 bg-accent/10 text-fg-2"
            title={`${t.name} — ${fmtClock(t.duration)}, ${t.parts.length} part(s) · pick it in a lighting clip's Source`}
          >
            <Lightbulb size={10} className="text-accent" />
            <span className="truncate max-w-[9rem]">{t.name}</span>
            <span className="text-fg-3">{t.parts.length}p</span>
            {onRemoveLightingTake && (
              <button onClick={() => onRemoveLightingTake(t.id)} className="text-fg-3 hover:text-danger" title="Delete take"><Trash2 size={10} /></button>
            )}
          </div>
        </Tooltip>
      ))}

      <span className="inline-flex items-center gap-1 text-fg-3 shrink-0"><Radio size={11} /> Takes</span>
      {takes.length === 0 && <span className="text-fg-3 italic shrink-0">none yet — record the tracker feed</span>}
      {takes.map(t => (
        <Tooltip key={t.id} id="timeline.take-chip">
          <div draggable onDragStart={(e) => onDragStart(e, t)}
            title={`${t.name} — ${fmtClock(t.duration)} · drag onto the tracking lane`}
            {...help('timeline.take-chip')}
            className="group inline-flex items-center gap-1 px-2 h-6 rounded shrink-0 border border-line-2 bg-surface-3 cursor-grab hover:border-accent">
            <span className="truncate max-w-[120px] text-fg-1">{t.name}</span>
            <span className="text-fg-3">{fmtClock(t.duration)}</span>
            <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemoveTake(t.id)}
              className="text-fg-3 hover:text-danger opacity-0 group-hover:opacity-100"><Trash2 size={10} /></button>
          </div>
        </Tooltip>
      ))}
    </div>
  );
};
