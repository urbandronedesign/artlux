import React, { useEffect, useState } from 'react';
import { StateMachine } from '../../types';
import { timeline as engine } from '../../services/timeline';
import { GUTTER, SM_LANE_H } from './geometry';
import { Workflow, ChevronsRight } from 'lucide-react';

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

  useEffect(() => engine.subscribeSmState(setCurrentId), []);

  const current = sm.states.find(s => s.id === currentId) ?? null;
  const manualOut = sm.transitions.filter(t => t.from === currentId && t.trigger.kind === 'manual');
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
        <button onClick={onEdit} className="ml-auto text-micro text-fg-3 hover:text-fg-1 underline">edit</button>
      </div>

      <div className="relative" style={{ width, height: SM_LANE_H, opacity: dim ? 0.45 : 1 }}>
        {/* manual triggers available from the current state — pinned at the left of the track */}
        <div className="absolute left-1 top-0 bottom-0 flex items-center gap-1 z-10">
          {sm.enabled && manualOut.map(t => {
            const to = sm.states.find(s => s.id === t.to);
            return (
              <button key={t.id} onClick={() => onTrigger(t.id)} title={`Trigger → ${to?.name ?? '?'}`}
                className="px-1.5 h-5 rounded bg-surface-2 border border-line-1 text-micro text-fg-1 hover:bg-accent hover:text-black inline-flex items-center gap-1">
                <ChevronsRight size={10} /> {to?.name ?? '?'}
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
