import React from 'react';
import { Play, Pause, Plus, ZoomIn, ZoomOut, Maximize, Minimize, Scan, Scissors, MousePointer2, Magnet, Flag, Repeat, Workflow } from 'lucide-react';

interface Props {
  playing: boolean;
  onTogglePlay: () => void;
  timeRef: React.RefObject<HTMLSpanElement>;
  duration: number;
  onChangeDuration: (d: number) => void;
  fps: number;
  onChangeFps: (f: number) => void;
  tool: 'select' | 'blade';
  onSetTool: (t: 'select' | 'blade') => void;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  onAddMarker: () => void;
  onZoom: (factor: number) => void;
  onZoomFit: () => void;
  onAddTrack: () => void;
  loop: boolean;
  onToggleLoop: () => void;
  smEnabled: boolean;
  onToggleSm: () => void;
  onEditLogic: () => void;
  maximized: boolean;
  onToggleMax: () => void;
}

const TBtn: React.FC<{ active?: boolean; title: string; onClick: () => void; children: React.ReactNode }> = ({ active, title, onClick, children }) => (
  <button title={title} onClick={onClick} className={`p-1.5 rounded-sm ${active ? 'bg-accent text-black' : 'bg-surface-2 text-fg-2 hover:text-fg-1'}`}>{children}</button>
);

export const TimelineToolbar: React.FC<Props> = ({ playing, onTogglePlay, timeRef, duration, onChangeDuration, fps, onChangeFps, tool, onSetTool, snapEnabled, onToggleSnap, onAddMarker, onZoom, onZoomFit, onAddTrack, loop, onToggleLoop, smEnabled, onToggleSm, onEditLogic, maximized, onToggleMax }) => (
  <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-line-1 bg-surface-1">
    <TBtn active={playing} title="Play / Pause (Space)" onClick={onTogglePlay}>
      {playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
    </TBtn>
    <TBtn active={loop} title="Loop in/out region (Shift+L)" onClick={onToggleLoop}><Repeat size={13} /></TBtn>
    <span ref={timeRef} className="num text-mini text-fg-1 tabular-nums w-44">00:00:00:00 / 00:00:00:00</span>

    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={tool === 'select'} title="Select tool (V)" onClick={() => onSetTool('select')}><MousePointer2 size={13} /></TBtn>
    <TBtn active={tool === 'blade'} title="Blade tool (B)" onClick={() => onSetTool('blade')}><Scissors size={13} /></TBtn>
    <TBtn active={snapEnabled} title="Snapping (S)" onClick={onToggleSnap}><Magnet size={13} /></TBtn>
    <TBtn title="Add marker at playhead (M)" onClick={onAddMarker}><Flag size={13} /></TBtn>

    <div className="w-px h-5 bg-line-1 mx-0.5" />
    <TBtn active={smEnabled} title="State machine: enable control layer" onClick={onToggleSm}><Workflow size={13} /></TBtn>
    <button onClick={onEditLogic} className="px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini">Edit logic</button>

    <div className="ml-auto flex items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="text-fg-3 text-micro">FPS</span>
        <input type="number" min={1} max={120} step={1} value={fps} onChange={(e) => onChangeFps(Math.max(1, Math.min(120, parseInt(e.target.value) || 30)))}
          className="w-11 bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-right num text-mini focus:border-accent focus:outline-none" />
      </div>
      <div className="flex items-center gap-1">
        <span className="text-fg-3 text-micro">Length</span>
        <input type="number" min={1} step={1} value={duration} onChange={(e) => onChangeDuration(Math.max(1, parseFloat(e.target.value) || 1))}
          className="w-14 bg-surface-0 border border-line-1 rounded px-1.5 py-0.5 text-right num text-mini focus:border-accent focus:outline-none" />
        <span className="text-fg-3 text-micro">s</span>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={() => onZoom(1 / 1.5)} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom out (- / wheel)"><ZoomOut size={13} /></button>
        <button onClick={onZoomFit} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom to fit"><Scan size={12} /></button>
        <button onClick={() => onZoom(1.5)} className="p-1 rounded text-fg-2 hover:text-fg-1" title="Zoom in (+ / wheel)"><ZoomIn size={13} /></button>
      </div>
      <button onClick={onAddTrack} className="flex items-center gap-1 px-2 py-1 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-mini"><Plus size={12} /> Track</button>
      <TBtn title={maximized ? 'Restore (F)' : 'Maximize (F)'} onClick={onToggleMax}>{maximized ? <Minimize size={13} /> : <Maximize size={13} />}</TBtn>
    </div>
  </div>
);
