import React, { useEffect, useState } from 'react';
import { Trash2, AlertTriangle } from 'lucide-react';
import { VideoClip, isContentClip, SourceType } from '../../types';
import { Filmstrip } from './Filmstrip';
import { BlobSparkline } from './BlobSparkline';
import { fmtClock } from './geometry';
import { ensureBlobUrl, mimeForPath } from '../../services/mediaCache';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';

export type DragMode = 'move' | 'l' | 'r';

// Cover-fit thumbnail for an IMAGE content clip — resolves the file to a blob URL (file:// can't
// be loaded directly), then fills the clip body like the video filmstrip does.
const ImageStrip: React.FC<{ path: string }> = ({ path }) => {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    if (!path) { setUrl(undefined); return; }
    let live = true;
    void ensureBlobUrl(path, mimeForPath(path)).then(u => { if (live) setUrl(u); });
    return () => { live = false; };
  }, [path]);
  if (!url) return null;
  return <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundRepeat: 'no-repeat' }} />;
};

interface Props {
  clip: VideoClip;
  selected: boolean;
  locked: boolean;
  tool: 'select' | 'blade';
  pxPerSec: number;
  laneH: number;
  conflict?: boolean; // a live receiver (Spout/NDI) is contested by another overlapping clip
  /** A lighting clip's authored pose keys, for the diamonds. Passed in rather than looked up here:
   *  this component is memoized on its props and must not read a store. */
  sequenceKeys?: ReadonlyArray<{ t: number; name?: string }>;
  onStartDrag: (e: React.PointerEvent, clip: VideoClip, mode: DragMode) => void;
  onBlade: (clip: VideoClip, clientX: number) => void;
  onRemove: (clipId: string) => void;
}

// A single clip on a lane. Memoized so an unrelated state change in the App tree doesn't repaint
// every clip — only clips whose inputs actually change re-render (key for perf in this no-memo app).
const ClipBlockBase: React.FC<Props> = ({ clip, selected, locked, tool, pxPerSec, laneH, conflict, sequenceKeys, onStartDrag, onBlade, onRemove }) => {
  const widthPx = Math.max(6, clip.duration * pxPerSec);
  const blade = tool === 'blade' && !locked;

  const onDown = (e: React.PointerEvent) => {
    if (blade) { e.stopPropagation(); e.preventDefault(); onBlade(clip, e.clientX); return; }
    if (locked) return;
    onStartDrag(e, clip, 'move');
  };

  return (
    <div
      onPointerDown={onDown}
      className={`absolute top-1 bottom-1 rounded-sm border overflow-hidden ${blade ? 'cursor-col-resize' : locked ? 'cursor-not-allowed' : 'cursor-grab'} ${selected ? 'border-accent bg-accent/20' : 'border-line-2 bg-surface-3'}`}
      style={{ left: clip.start * pxPerSec, width: widthPx, borderLeftColor: clip.color, borderLeftWidth: clip.color ? 3 : undefined }}
      title={`${clip.name} — ${fmtClock(clip.duration)}`}
    >
      {widthPx > 18 && (clip.kind === 'tracking'
        ? <BlobSparkline path={clip.path} inPoint={clip.inPoint} clipDuration={clip.duration} widthPx={widthPx} heightPx={laneH - 8} />
        : clip.kind === 'lighting'
        // A lighting clip has no picture and no waveform — what identifies it is the MOVEMENT it
        // carries, so say that instead of leaving an anonymous block.
        ? <div className="absolute inset-0 bg-accent/10 pointer-events-none">
            <div className="flex items-center gap-1 px-1.5 text-micro uppercase tracking-wider text-fg-2">
              <span className="truncate">
                {clip.lighting?.sequenceId ? 'keys' : clip.lighting?.effect ? clip.lighting.effect.form : 'take'}
              </span>
              {clip.lighting?.phase ? <span className="text-fg-3">· ϕ{clip.lighting.phase}s</span> : null}
            </div>
            {/* KEY DIAMONDS. A clip whose keys you cannot see is not authorable — you would be
                storing into an invisible list and guessing where the previous one landed. Drawn from
                the clip's own trim, so sliding or trimming the clip moves them with the look. */}
            {sequenceKeys?.map((k) => {
              const x = (k.t - (clip.inPoint ?? 0)) * pxPerSec;
              if (x < 0 || x > widthPx) return null;
              return (
                <div
                  key={k.t}
                  className="absolute bottom-1 w-1.5 h-1.5 rotate-45 bg-accent border border-black/40"
                  style={{ left: x - 3 }}
                  title={k.name ? `${k.name} — ${k.t.toFixed(2)}s` : `key @ ${k.t.toFixed(2)}s`}
                />
              );
            })}
          </div>
        : isContentClip(clip)
          ? (clip.content!.type === SourceType.IMAGE && (clip.content!.url || clip.path)
            ? <ImageStrip path={clip.content!.url || clip.path} />
            : <div className="absolute inset-0 flex items-center justify-center text-micro uppercase tracking-wider text-fg-3 bg-surface-2/40 pointer-events-none">{clip.content!.type === 'EFFECT' ? 'EFFECT' : clip.content!.type}</div>)
          : <Filmstrip path={clip.path} inPoint={clip.inPoint} clipDuration={clip.duration} widthPx={widthPx} heightPx={laneH - 8} />)}
      <div className="absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-black/55 to-transparent pointer-events-none" />
      <div className="relative px-1.5 pt-0.5 text-micro leading-tight truncate text-fg-1 pointer-events-none drop-shadow">{clip.name}</div>
      {conflict && <div title="Another clip/surface is using this live input — the last one under the playhead wins" className="absolute bottom-0.5 left-1 text-warn pointer-events-none"><AlertTriangle size={10} /></div>}
      {!blade && !locked && <>
        <div onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, clip, 'l'); }} className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
        <div onPointerDown={(e) => { e.stopPropagation(); onStartDrag(e, clip, 'r'); }} className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize bg-black/40 hover:bg-accent" />
      </>}
      {selected && !locked && (
        <Tooltip id="timeline.clip-remove">
          <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(clip.id)} {...help('timeline.clip-remove')} title="Delete clip" className="absolute top-0.5 right-2 text-fg-2 hover:text-danger"><Trash2 size={10} /></button>
        </Tooltip>
      )}
    </div>
  );
};

export const ClipBlock = React.memo(ClipBlockBase);
