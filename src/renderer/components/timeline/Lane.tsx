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
  conflictIds?: Set<string>;
  /** clip id → its sequence's key times, for the lighting diamonds. Built once by Timeline. */
  sequenceKeys?: Map<string, ReadonlyArray<{ t: number; name?: string }>>;
  selectedKey?: { clipId: string; t: number } | null;
  onSelectKey?: (clipId: string, t: number) => void;
  onSeek: (clientX: number) => void;
  onDropFile: (e: React.DragEvent, layerId: string) => void;
  onAddContent?: (e: React.MouseEvent, layerId: string) => void; // right-click empty lane → source picker
  onStartDrag: (e: React.PointerEvent, clip: VideoClip, mode: DragMode) => void;
  onBlade: (clip: VideoClip, clientX: number) => void;
  onRemoveClip: (clipId: string) => void;
}

export const Lane: React.FC<Props> = ({ layer, clips, selectedId, tool, pxPerSec, width, laneH, conflictIds, sequenceKeys, selectedKey, onSelectKey, onSeek, onDropFile, onAddContent, onStartDrag, onBlade, onRemoveClip }) => {
  const locked = !!layer.locked;
  const dim = layer.enabled === false || layer.muted;
  return (
    <div
      className={`relative border-b border-line-1 ${dim ? 'opacity-40' : ''} ${layer.solo ? 'bg-accent/5' : ''}`}
      style={{ height: laneH, width }}
      onDragOver={(e) => { if (!locked) e.preventDefault(); }}
      onDrop={(e) => { if (!locked) onDropFile(e, layer.id); }}
      onPointerDown={(e) => { if (e.button === 0 && e.target === e.currentTarget) onSeek(e.clientX); }}
      onContextMenu={(e) => { if (e.target === e.currentTarget && onAddContent) onAddContent(e, layer.id); }}
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
          conflict={conflictIds?.has(c.id)}
          sequenceKeys={sequenceKeys?.get(c.id)}
          selectedKeyT={selectedKey?.clipId === c.id ? selectedKey.t : undefined}
          onSelectKey={onSelectKey}
          onStartDrag={onStartDrag}
          onBlade={onBlade}
          onRemove={onRemoveClip}
        />
      ))}
    </div>
  );
};
