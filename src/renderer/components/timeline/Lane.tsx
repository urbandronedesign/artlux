import React from 'react';
import { VideoClip, VideoLayer } from '../../types';
import { ClipBlock, DragMode } from './ClipBlock';

interface Props {
  layer: VideoLayer;
  clips: VideoClip[];          // already filtered to this layer + draft override applied
  selectedId: string | null;
  tool: 'select' | 'blade';
  pxPerSec: number;
  width: number;
  laneH: number;
  onSeek: (clientX: number) => void;
  onDropFile: (e: React.DragEvent, layerId: string) => void;
  onStartDrag: (e: React.PointerEvent, clip: VideoClip, mode: DragMode) => void;
  onBlade: (clip: VideoClip, clientX: number) => void;
  onRemoveClip: (clipId: string) => void;
}

export const Lane: React.FC<Props> = ({ layer, clips, selectedId, tool, pxPerSec, width, laneH, onSeek, onDropFile, onStartDrag, onBlade, onRemoveClip }) => {
  const locked = !!layer.locked;
  const dim = layer.enabled === false || layer.muted;
  return (
    <div
      className={`relative border-b border-line-1 ${dim ? 'opacity-40' : ''} ${layer.solo ? 'bg-accent/5' : ''}`}
      style={{ height: laneH, width }}
      onDragOver={(e) => { if (!locked) e.preventDefault(); }}
      onDrop={(e) => { if (!locked) onDropFile(e, layer.id); }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onSeek(e.clientX); }}
    >
      {clips.map(c => (
        <ClipBlock
          key={c.id}
          clip={c}
          selected={selectedId === c.id}
          locked={locked}
          tool={tool}
          pxPerSec={pxPerSec}
          laneH={laneH}
          onStartDrag={onStartDrag}
          onBlade={onBlade}
          onRemove={onRemoveClip}
        />
      ))}
    </div>
  );
};
