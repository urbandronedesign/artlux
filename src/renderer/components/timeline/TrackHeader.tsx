import React, { useState } from 'react';
import { Trash2, Eye, EyeOff, Lock, Unlock, GripVertical, Blend } from 'lucide-react';
import { VideoLayer, LayerBlendMode } from '../../types';

const BLEND_MODES: LayerBlendMode[] = ['normal', 'add', 'screen', 'multiply'];

const TRACK_COLORS = ['#27b6c4', '#ff3b3b', '#f5a623', '#7ed321', '#bd10e0', '#4a90e2'];

interface Props {
  layer: VideoLayer;
  index: number;
  height: number;
  onPatch: (id: string, patch: Partial<VideoLayer>) => void;
  onRemove: (id: string) => void;
  onStartReorder: (e: React.PointerEvent, index: number) => void;
  onStartResize: (e: React.PointerEvent, layer: VideoLayer) => void;
}

const Toggle: React.FC<{ on: boolean; label: string; title: string; color?: string; onClick: () => void }> = ({ on, label, title, color, onClick }) => (
  <button
    title={title}
    onPointerDown={(e) => e.stopPropagation()}
    onClick={onClick}
    className={`w-4 h-4 rounded-sm text-micro font-bold flex items-center justify-center border ${on ? 'text-black border-transparent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}
    style={on ? { background: color ?? 'var(--accent)' } : undefined}
  >{label}</button>
);

const TrackHeaderBase: React.FC<Props> = ({ layer, index, height, onPatch, onRemove, onStartReorder, onStartResize }) => {
  const [fxOpen, setFxOpen] = useState(false);
  const fxActive = (layer.opacity ?? 1) < 1 || (layer.blendMode ?? 'normal') !== 'normal';
  const cycleColor = () => {
    const i = layer.color ? TRACK_COLORS.indexOf(layer.color) : -1;
    const next = i + 1 >= TRACK_COLORS.length ? undefined : TRACK_COLORS[i + 1];
    onPatch(layer.id, { color: next });
  };
  return (
    <div className="relative flex flex-col justify-center gap-1 px-1.5 py-1 border-b border-line-1 bg-surface-1" style={{ height }}>
      <div className="flex items-center gap-1">
        <span onPointerDown={(e) => onStartReorder(e, index)} className="cursor-grab text-fg-3 hover:text-fg-1 -ml-0.5" title="Drag to reorder"><GripVertical size={12} /></span>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={cycleColor} title="Track color" className="w-2.5 h-2.5 rounded-sm border border-line-2 shrink-0" style={{ background: layer.color ?? 'transparent' }} />
        <input
          value={layer.name}
          onChange={(e) => onPatch(layer.id, { name: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent text-mini text-fg-1 focus:bg-surface-0 rounded px-1 outline-none"
        />
        <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(layer.id)} className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
      </div>
      <div className="flex items-center gap-1">
        <Toggle on={!!layer.muted} label="M" title="Mute (visual)" color="#f5a623" onClick={() => onPatch(layer.id, { muted: !layer.muted })} />
        <Toggle on={!!layer.solo} label="S" title="Solo (visual)" color="#27b6c4" onClick={() => onPatch(layer.id, { solo: !layer.solo })} />
        <button title={layer.locked ? 'Unlock' : 'Lock'} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPatch(layer.id, { locked: !layer.locked })}
          className={`w-4 h-4 rounded-sm flex items-center justify-center border ${layer.locked ? 'bg-danger text-black border-transparent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}>
          {layer.locked ? <Lock size={10} /> : <Unlock size={10} />}
        </button>
        <button title={layer.enabled === false ? 'Show' : 'Hide'} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPatch(layer.id, { enabled: layer.enabled === false })}
          className={`w-4 h-4 rounded-sm flex items-center justify-center border ${layer.enabled === false ? 'text-fg-3 border-line-2 hover:text-fg-1' : 'text-fg-1 border-line-2'}`}>
          {layer.enabled === false ? <EyeOff size={10} /> : <Eye size={10} />}
        </button>
        {/* Opacity + blend for the timeline (Program) composite — popover so it fits any track height. */}
        <button title="Opacity & blend in the Timeline (Program) composite" onPointerDown={(e) => e.stopPropagation()} onClick={() => setFxOpen(v => !v)}
          className={`w-4 h-4 rounded-sm flex items-center justify-center border ${fxActive || fxOpen ? 'text-black border-transparent bg-accent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}>
          <Blend size={10} />
        </button>
      </div>
      {fxOpen && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={(e) => { e.stopPropagation(); setFxOpen(false); }} />
          <div className="absolute left-1.5 top-full -mt-1 z-50 w-44 bg-surface-1 border border-line-1 rounded-md p-2 shadow-e2 space-y-1.5"
            onPointerDown={(e) => e.stopPropagation()}>
            <div className="text-micro uppercase tracking-wider text-fg-3">Program composite</div>
            <div className="flex items-center gap-1.5">
              <span className="text-micro text-fg-2 w-10">Opacity</span>
              <input type="range" min={0} max={1} step={0.01} value={layer.opacity ?? 1}
                onChange={(e) => onPatch(layer.id, { opacity: parseFloat(e.target.value) })} className="flex-1 min-w-0 h-1 accent-accent" />
              <span className="text-micro num text-fg-3 w-7 text-right">{Math.round((layer.opacity ?? 1) * 100)}%</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-micro text-fg-2 w-10">Blend</span>
              <select value={layer.blendMode ?? 'normal'} onChange={(e) => onPatch(layer.id, { blendMode: e.target.value as LayerBlendMode })}
                className="flex-1 bg-surface-0 border border-line-1 rounded text-micro text-fg-1 px-1 py-0.5 outline-none focus:border-accent">
                {BLEND_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        </>
      )}
      {/* height resize grab strip */}
      <div onPointerDown={(e) => onStartResize(e, layer)} className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-accent/40" />
    </div>
  );
};

export const TrackHeader = React.memo(TrackHeaderBase);
