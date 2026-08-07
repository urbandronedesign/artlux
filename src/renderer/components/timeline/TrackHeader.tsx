import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, Eye, EyeOff, Lock, Unlock, GripVertical, Blend, Volume2, VolumeX } from 'lucide-react';
import { VideoLayer, LayerBlendMode } from '../../types';
import { Tooltip } from '../ui/Tooltip';
import { help } from '../../services/helpBus';
import { usePopoverAnchor } from './usePopoverAnchor';

const BLEND_MODES: LayerBlendMode[] = ['normal', 'add', 'screen', 'multiply'];

const TRACK_COLORS = ['#27b6c4', '#ff3b3b', '#f5a623', '#7ed321', '#bd10e0', '#4a90e2'];

const FX_W = 176;   // must match w-44
const FX_M = 8;     // viewport margin

interface Props {
  layer: VideoLayer;
  index: number;
  height: number;
  /** This row is the one a reorder drag is currently carrying. Owned by Timeline (its `draggingId`). */
  dragging?: boolean;
  onPatch: (id: string, patch: Partial<VideoLayer>) => void;
  onRemove: (id: string) => void;
  onStartReorder: (e: React.PointerEvent, index: number) => void;
  onStartResize: (e: React.PointerEvent, layer: VideoLayer) => void;
}

// `helpId`, when given, opts the toggle into the rich help system (a hoverable tooltip with a "? Learn
// more" deep-link + the StatusBar context line), exactly like TimelineToolbar's TBtn. The native `title`
// stays as the accessible name and the fallback for toggles without an entry.
const Toggle: React.FC<{ on: boolean; label: string; title: string; helpId?: string; color?: string; onClick: () => void }> = ({ on, label, title, helpId, color, onClick }) => {
  const btn = (
    <button
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      {...(helpId ? help(helpId) : {})}
      className={`w-4 h-4 rounded-sm text-micro font-bold flex items-center justify-center border ${on ? 'text-black border-transparent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}
      style={on ? { background: color ?? 'var(--accent)' } : undefined}
    >{label}</button>
  );
  return helpId ? <Tooltip id={helpId}>{btn}</Tooltip> : btn;
};

const TrackHeaderBase: React.FC<Props> = ({ layer, index, height, dragging, onPatch, onRemove, onStartReorder, onStartResize }) => {
  const [fxOpen, setFxOpen] = useState(false);
  const fxBtnRef = useRef<HTMLButtonElement>(null);
  const fxBoxRef = useRef<HTMLDivElement>(null);
  const fxActive = (layer.opacity ?? 1) < 1 || (layer.blendMode ?? 'normal') !== 'normal';
  const closeFx = useCallback(() => setFxOpen(false), []);
  const fxPos = usePopoverAnchor(fxOpen, fxBtnRef, { width: FX_W, estHeight: 96, boxRef: fxBoxRef, margin: FX_M, onDismiss: closeFx });

  const cycleColor = () => {
    const i = layer.color ? TRACK_COLORS.indexOf(layer.color) : -1;
    const next = i + 1 >= TRACK_COLORS.length ? undefined : TRACK_COLORS[i + 1];
    onPatch(layer.id, { color: next });
  };
  return (
    <div className={`relative flex flex-col justify-center gap-1 px-1.5 py-1 border-b border-line-1 ${dragging ? 'bg-surface-2 ring-1 ring-inset ring-accent' : 'bg-surface-1'}`} style={{ height }}>
      <div className="flex items-center gap-1">
        {/* THE REORDER HANDLE. It was a bare 12px glyph at the DIMMEST text tier carrying a native `title`
            and nothing else, and operators simply never found it — it was also the only control in this
            header not wired into the help system, while all seven of its siblings carry Tooltip + help().
            Three changes, and NOT a new gesture (startReorder is careful, and stays as it is):
              · a real hit target with a hover chip, so it reads as interactive AT REST instead of only
                once you happen to land on the exact glyph;
              · fg-2, not fg-3 — the dim tier is for meta and captions, not for an affordance;
              · Tooltip + help(), for the hover card, the "? Learn more" deep-link and the StatusBar line.
            `cursor-grabbing` during the drag is belt-and-braces: the pointer leaves this element
            immediately, so Timeline also paints the cursor on the body for the rest of the gesture. */}
        <Tooltip id="timeline.track-reorder">
          <span
            onPointerDown={(e) => onStartReorder(e, index)}
            {...help('timeline.track-reorder')}
            title="Drag to reorder — the top track is front-most"
            className={`-ml-0.5 shrink-0 w-4 h-5 rounded-sm flex items-center justify-center ${dragging ? 'cursor-grabbing text-fg-1 bg-surface-3' : 'cursor-grab text-fg-2 hover:text-fg-1 hover:bg-surface-3'}`}
          ><GripVertical size={12} /></span>
        </Tooltip>
        <button onPointerDown={(e) => e.stopPropagation()} onClick={cycleColor} title="Track color" className="w-2.5 h-2.5 rounded-sm border border-line-2 shrink-0" style={{ background: layer.color ?? 'transparent' }} />
        <input
          value={layer.name}
          onChange={(e) => onPatch(layer.id, { name: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent text-mini text-fg-1 focus:bg-surface-0 rounded px-1 outline-none"
        />
        <Tooltip id="timeline.track-remove">
          <button onPointerDown={(e) => e.stopPropagation()} onClick={() => onRemove(layer.id)} {...help('timeline.track-remove')} title="Delete track" className="text-fg-3 hover:text-danger shrink-0"><Trash2 size={11} /></button>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1">
        <Toggle on={!!layer.muted} label="M" title="Mute (visual)" helpId="timeline.track-mute" color="#f5a623" onClick={() => onPatch(layer.id, { muted: !layer.muted })} />
        <Toggle on={!!layer.solo} label="S" title="Solo (visual)" helpId="timeline.track-solo" color="#27b6c4" onClick={() => onPatch(layer.id, { solo: !layer.solo })} />
        <Tooltip id="timeline.track-lock">
          <button title={layer.locked ? 'Unlock' : 'Lock'} {...help('timeline.track-lock')} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPatch(layer.id, { locked: !layer.locked })}
            className={`w-4 h-4 rounded-sm flex items-center justify-center border ${layer.locked ? 'bg-danger text-black border-transparent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}>
            {layer.locked ? <Lock size={10} /> : <Unlock size={10} />}
          </button>
        </Tooltip>
        <Tooltip id="timeline.track-hide">
          <button title={layer.enabled === false ? 'Show' : 'Hide'} {...help('timeline.track-hide')} onPointerDown={(e) => e.stopPropagation()} onClick={() => onPatch(layer.id, { enabled: layer.enabled === false })}
            className={`w-4 h-4 rounded-sm flex items-center justify-center border ${layer.enabled === false ? 'text-fg-3 border-line-2 hover:text-fg-1' : 'text-fg-1 border-line-2'}`}>
            {layer.enabled === false ? <EyeOff size={10} /> : <Eye size={10} />}
          </button>
        </Tooltip>
        {/* THE LAYER'S SOUND — its clips' own soundtracks, NOT the same thing as the `M` two buttons left.
            That one is the PROGRAM composite (a picture flag); this silences every video clip on the track.
            Two separate concepts sharing a track header is exactly why they get two separate buttons and
            two separate fields (VideoLayer.muted vs VideoLayer.audio.mute) — hiding a layer must not
            silence it, and silencing it must not hide it. */}
        <Tooltip id="timeline.track-audio-mute">
          <button title={layer.audio?.mute ? 'Un-mute this track’s video audio' : 'Mute this track’s video audio'}
            {...help('timeline.track-audio-mute')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onPatch(layer.id, { audio: { ...layer.audio, mute: !layer.audio?.mute } })}
            className={`w-4 h-4 rounded-sm flex items-center justify-center border ${layer.audio?.mute ? 'bg-warn text-black border-transparent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}>
            {layer.audio?.mute ? <VolumeX size={10} /> : <Volume2 size={10} />}
          </button>
        </Tooltip>
        {/* Opacity + blend for the timeline (Program) composite — popover so it fits any track height. */}
        <Tooltip id="timeline.track-blend">
          <button ref={fxBtnRef} title="Opacity & blend in the Timeline (Program) composite" {...help('timeline.track-blend')} onPointerDown={(e) => e.stopPropagation()} onClick={() => setFxOpen(v => !v)}
            className={`w-4 h-4 rounded-sm flex items-center justify-center border ${fxActive || fxOpen ? 'text-black border-transparent bg-accent' : 'text-fg-3 border-line-2 hover:text-fg-1'}`}>
            <Blend size={10} />
          </button>
        </Tooltip>
      </div>
      {/* PORTALLED, ON THE `popover` TIER — see usePopoverAnchor for the why. Short version: this row's
          gutter is `sticky left-0 z-20` in Timeline.tsx, which is a STACKING CONTEXT, so an
          `absolute … z-50` panel collapsed to z-20 and painted under the NEXT track's header — same z,
          later sibling, same 188px column. Backdrop and box share the tier and are ordered by DOM
          (later sibling wins), so keep the box second. */}
      {fxOpen && createPortal(
        <>
          <div className="fixed inset-0 z-popover" onPointerDown={(e) => { e.stopPropagation(); setFxOpen(false); }} />
          <div ref={fxBoxRef}
            className="fixed z-popover w-44 bg-surface-1 border border-line-1 rounded-md p-2 shadow-e3 space-y-1.5"
            // Hidden until measured — a first paint at 0,0 flashes the panel in the window corner.
            style={{ left: fxPos?.left ?? 0, top: fxPos?.top ?? 0, visibility: fxPos ? 'visible' : 'hidden' }}
            onPointerDown={(e) => e.stopPropagation()}
            // The portal takes us out of the timeline scroller's subtree, which kills its NON-PASSIVE
            // native wheel-zoom listener; this stops React's synthetic wheel travelling the React tree
            // as well, so spinning over the panel can't zoom the timeline underneath it.
            onWheel={(e) => e.stopPropagation()}>
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
        </>,
        document.body,
      )}
      {/* height resize grab strip */}
      <div onPointerDown={(e) => onStartResize(e, layer)} className="absolute left-0 right-0 bottom-0 h-1.5 cursor-ns-resize hover:bg-accent/40" />
    </div>
  );
};

export const TrackHeader = React.memo(TrackHeaderBase);
