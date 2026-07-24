import React, { useEffect, useState } from 'react';
import { StateMachine } from '../../types';
import { timeline as engine } from '../../services/timeline';
import { GUTTER, SM_LANE_H } from './geometry';
import { Workflow, ChevronsRight, Zap } from 'lucide-react';

interface Props {
  sm: StateMachine;
  pxPerSec: number;
  width: number;
  onTrigger: (transitionId: string) => void;
  onEdit: () => void;
  onToggle: () => void;
}

// The always-present control-layer lane. Shows the live current state, manual-trigger buttons for
// the current state's outgoing manual transitions, and time-anchored trigger markers on the track.
export const StateLane: React.FC<Props> = ({ sm, pxPerSec, width, onTrigger, onEdit, onToggle }) => {
  const [currentId, setCurrentId] = useState<string | null>(null);
  // IS THE STATE'S PICTURE OVER? (Timeline.holdAtEnd — the playhead is parked on the last frame while
  // the show plays on.) It has no event of its own, so it is POLLED at 4 Hz and only committed when it
  // CHANGES — a hold lasts seconds to minutes, and this lane must not re-render per frame during
  // playback. Without this readout a hold is invisible: `playing` is true, the timecode is frozen, and
  // from across a venue that is indistinguishable from a show that has hung.
  const [held, setHeld] = useState(false);

  useEffect(() => engine.subscribeSmState(setCurrentId), []);
  useEffect(() => {
    const id = window.setInterval(() => setHeld(h => (h === engine.isBoundHeld() ? h : !h)), 250);
    return () => window.clearInterval(id);
  }, []);

  const current = sm.states.find(s => s.id === currentId) ?? null;
  // The current state's own manual transitions, PLUS global rules (fromAny), which are firable from
  // wherever the show happens to be — that is what makes them global, and the runtime honours them on
  // this path too (stateMachine.triggerManual). A global pointing at the state we are already in is
  // excluded for the same reason tick() skips it: pressing it would re-enter and restart the scene.
  const manualOut = sm.transitions.filter(t => t.trigger.kind === 'manual'
    && (t.fromAny ? t.to !== currentId : t.from === currentId));
  const timeTriggers = sm.transitions.filter(t => t.trigger.kind === 'atTime' && t.trigger.time != null);
  const dim = !sm.enabled;

  return (
    <div className="flex border-b border-line-1 bg-surface-1/40">
      <div className="sticky left-0 z-20 shrink-0 bg-surface-1 border-r border-line-1 flex items-center gap-1.5 px-2" style={{ width: GUTTER, height: SM_LANE_H }}>
        <button onClick={onToggle} title={sm.enabled ? 'State machine ON (click to disable)' : 'State machine OFF (click to enable)'}
          className={`inline-flex items-center justify-center h-5 w-5 rounded ${sm.enabled ? 'bg-accent text-black' : 'bg-surface-2 text-fg-3'}`}>
          <Workflow size={12} />
        </button>
        <span className="text-micro text-fg-2 truncate" title={current ? current.name : 'no state'}>
          {sm.enabled ? (current ? current.name : (sm.states.length ? '—' : 'empty')) : 'disabled'}
        </span>
        {held && (
          <span className="shrink-0 px-1 h-4 rounded bg-warn/20 text-warn text-micro inline-flex items-center"
            title="This state's timeline has finished and is holding its last frame. The show is still running — the audio bed and the global automation play on — and any transition waiting on 'only after the state has finished' can now fire.">HOLDING</span>
        )}
        <button onClick={onEdit} className="ml-auto text-micro text-fg-3 hover:text-fg-1 underline">edit</button>
      </div>

      <div className="relative" style={{ width, height: SM_LANE_H, opacity: dim ? 0.45 : 1 }}>
        {/* manual triggers available from the current state — pinned at the left of the track */}
        <div className="absolute left-1 top-0 bottom-0 flex items-center gap-1 z-10">
          {sm.enabled && manualOut.map(t => {
            const to = sm.states.find(s => s.id === t.to);
            // `requireEnd` gates the AUTOMATIC path only — a human press always fires (stateMachine's
            // triggerManual). So the button is NOT disabled; it is flagged EARLY, so the operator knows
            // they are about to cut the state's picture before it has finished and still gets to decide.
            const early = !!t.requireEnd && !held;
            return (
              <button key={t.id} onClick={() => onTrigger(t.id)}
                title={early
                  ? `→ ${to?.name ?? '?'} — this state's timeline hasn't finished yet; firing now cuts it`
                  : `Trigger → ${to?.name ?? '?'}${t.fromAny ? ' (global rule — available from every state)' : ''}`}
                className={`px-1.5 h-5 rounded bg-surface-2 border text-micro inline-flex items-center gap-1 text-fg-1 hover:bg-accent hover:text-black ${early ? 'border-dashed border-warn/70' : t.fromAny ? 'border-warn/60' : 'border-line-1'}`}>
                {t.fromAny ? <Zap size={10} /> : <ChevronsRight size={10} />} {to?.name ?? '?'}{early ? ' ⏱' : ''}
              </button>
            );
          })}
        </div>
        {/* time-anchored transitions shown as diamonds on the track */}
        {timeTriggers.map(t => (
          <div key={t.id} className="absolute top-1/2 -translate-y-1/2 -ml-[5px] w-[10px] h-[10px] rotate-45 bg-accent/70 border border-accent pointer-events-none"
            style={{ left: (t.trigger.time ?? 0) * pxPerSec }} title={`@ ${(t.trigger.time ?? 0).toFixed(2)}s`} />
        ))}
      </div>
    </div>
  );
};
