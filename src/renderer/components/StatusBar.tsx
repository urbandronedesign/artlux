import React, { useEffect, useRef, useState } from 'react';
import { PanelLeft, PanelRight, Activity, Wifi, Workflow } from 'lucide-react';
import { helpBus, type HelpText, type HelpLang } from '../services/helpBus';
import { timeline as engine } from '../services/timeline';
import { StateMachine } from '../types';

interface Props {
  help: string;
  lang: HelpLang;
  renderFps: number;
  connected: boolean;
  outputStats: { pps: number; fps: number; universes: number } | null;
  leftOpen: boolean;
  onToggleLeft: () => void;
  rightOpen: boolean;
  onToggleRight: () => void;
  targetIp: string;
  stateMachine: StateMachine; // project-level show machine — current state + elapsed readout
}

// Always-visible readout of the running show machine: active state name + elapsed time. The machine
// runs on a standalone clock (it can be live with the timeline stopped), so this lives in the main
// chrome, not just the timeline lane. Elapsed is written imperatively via rAF to avoid a per-frame
// React re-render of App; only the state NAME goes through React (changes rarely).
const ShowStateChip: React.FC<{ sm: StateMachine }> = ({ sm }) => {
  const [currentId, setCurrentId] = useState<string | null>(null);
  const elapsedRef = useRef<HTMLSpanElement>(null);
  useEffect(() => engine.subscribeSmState(setCurrentId), []);
  const state = sm.states.find(s => s.id === currentId) ?? null;
  const visible = sm.enabled && !!state;
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      const el = elapsedRef.current;
      if (el) {
        const s = Math.max(0, Math.floor(engine.getSmElapsedSec()));
        el.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible]);
  if (!visible || !state) return null;
  const lock = state.lockSec ? ` · lock ${state.lockSec}s` : '';
  return (
    <>
      <div className="flex items-center gap-1.5" title={`State machine — in "${state.name}"${lock}`}>
        <Workflow size={12} className="text-accent" />
        <span className="text-fg-2 truncate max-w-[140px]">{state.name}</span>
        <span ref={elapsedRef} className="num text-fg-3">00:00</span>
      </div>
      <div className="h-3 w-px bg-line-2" />
    </>
  );
};

export const StatusBar: React.FC<Props> = ({ help, lang, renderFps, connected, outputStats, leftOpen, onToggleLeft, rightOpen, onToggleRight, targetIp, stateMachine }) => {
  const [hint, setHint] = useState<HelpText | null>(null);
  useEffect(() => helpBus.subscribe(setHint), []);

  return (
  <div className="h-7 shrink-0 bg-surface-1 border-t border-line-1 flex items-center justify-between px-3 text-xs text-fg-2 select-none">
    <div className="flex items-center gap-3 min-w-0">
      <button
        onClick={onToggleLeft}
        title="Toggle left panel"
        aria-label="Toggle left panel"
        className={`inline-flex items-center justify-center h-5 w-5 rounded-[var(--r-sm)] hover:text-fg-1 hover:bg-surface-3 ${leftOpen ? 'text-accent' : 'text-fg-3'}`}
      >
        <PanelLeft size={13} />
      </button>
      <button
        onClick={onToggleRight}
        title="Toggle right panel"
        aria-label="Toggle right panel"
        className={`inline-flex items-center justify-center h-5 w-5 rounded-[var(--r-sm)] hover:text-fg-1 hover:bg-surface-3 ${rightOpen ? 'text-accent' : 'text-fg-3'}`}
      >
        <PanelRight size={13} />
      </button>
      <span className={`truncate ${hint ? 'text-fg-2' : 'text-fg-3'}`}>{hint ? hint[lang] : help}</span>
    </div>

    <div className="flex items-center gap-4 shrink-0">
      <ShowStateChip sm={stateMachine} />
      <div className="flex items-center gap-1.5" title="Render FPS">
        <Activity size={12} className="text-ok" />
        <span className="num">{renderFps.toFixed(0)} FPS</span>
      </div>
      <div className="h-3 w-px bg-line-2" />
      <div className="flex items-center gap-1.5" title={`Target: ${targetIp}`}>
        <Wifi size={12} className={connected ? 'text-accent' : 'text-fg-3'} />
        <span className={connected ? 'text-accent' : 'text-fg-3'}>{connected ? 'LIVE' : 'OFFLINE'}</span>
      </div>
      {outputStats && (outputStats.pps > 0 || outputStats.universes > 0) && (
        <>
          <div className="h-3 w-px bg-line-2" />
          <span className="num text-fg-3" title="Native engine: frames/s · packets/s · universes">
            {outputStats.fps}Hz · {outputStats.pps}pps · {outputStats.universes}u
          </span>
        </>
      )}
    </div>
  </div>
  );
};
