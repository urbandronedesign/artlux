import React, { useEffect, useState } from 'react';
import { PanelLeft, Activity, Wifi } from 'lucide-react';
import { helpBus } from '../services/helpBus';

interface Props {
  help: string;
  renderFps: number;
  connected: boolean;
  outputStats: { pps: number; fps: number; universes: number } | null;
  leftOpen: boolean;
  onToggleLeft: () => void;
  targetIp: string;
}

export const StatusBar: React.FC<Props> = ({ help, renderFps, connected, outputStats, leftOpen, onToggleLeft, targetIp }) => {
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => helpBus.subscribe(setHint), []);

  return (
  <div className="h-7 shrink-0 bg-surface-1 border-t border-line-1 flex items-center justify-between px-3 text-xs text-fg-2 select-none">
    <div className="flex items-center gap-3 min-w-0">
      <button
        onClick={onToggleLeft}
        title="Toggle panel"
        aria-label="Toggle left panel"
        className={`inline-flex items-center justify-center h-5 w-5 rounded-[var(--r-sm)] hover:text-fg-1 hover:bg-surface-3 ${leftOpen ? 'text-accent' : 'text-fg-3'}`}
      >
        <PanelLeft size={13} />
      </button>
      <span className={`truncate ${hint ? 'text-fg-2' : 'text-fg-3'}`}>{hint ?? help}</span>
    </div>

    <div className="flex items-center gap-4 shrink-0">
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
