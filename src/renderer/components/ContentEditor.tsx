import React from 'react';
import { SurfaceContent, SourceType, VideoLayer, Surface } from '../types';
import { FULL_RECT, type SrcRect } from '../../../shared/protocol';
import { clampRect } from '../services/outputSpan';
import { Monitor, Image as ImageIcon, Video, Sparkles, Network, Cast, Radio, Slash, Film, Clapperboard, Crosshair, PersonStanding, Radar, Crop } from 'lucide-react';
import { Slider } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';
import { EFFECT_NAMES } from '../gpu/effects';
import { PALETTE_NAMES } from '../gpu/palettes';
import { contentSourceRegistry } from '../host/registries';
import { CameraSettings } from './CameraSettings';

// The content-source picker grid + per-type config (Spout sender, NDI source, Effect params,
// Tracking options, Layer track, opacity). Shared by the surface inspector and the timeline clip
// inspector so both edit a SurfaceContent identically. `onChange` merges a patch into the content;
// `onTypeChange` switches the source type (resetting per-type fields). File types (Video/Image)
// resolve a path and merge { type, url }. Set showLayerOption=false for timeline clips (a layer
// can't host a clip of itself).
interface ContentEditorProps {
  content: SurfaceContent;
  onChange: (patch: Partial<SurfaceContent>) => void;
  onTypeChange: (type: SurfaceContent['type']) => void;
  layers: VideoLayer[];
  showLayerOption?: boolean;
  // Slice support (surface inspector only — a timeline clip has no surface to crop). Omitting either
  // hides the Slice option, which is how the clip inspector opts out without another flag.
  surfaces?: Surface[];
  selfId?: string;
}

const btnCls = (active: boolean) =>
  `flex flex-col items-center justify-center p-2 rounded border transition-all ${active ? 'bg-sel-surface/10 border-sel-surface text-sel-surface' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`;

const ContentEditorImpl: React.FC<ContentEditorProps> = ({ content: c, onChange, onTypeChange, layers, showLayerOption = true, surfaces, selfId }) => {
  // Sliceable = anything that isn't this surface and isn't itself a slice (slices don't nest —
  // any sub-region is expressible as one rect on the original, and refusing it removes every cycle).
  const sliceable = (surfaces ?? []).filter((s) => s.id !== selfId && s.content.type !== SourceType.SLICE);
  const canSlice = !!surfaces && !!selfId;
  const rect: SrcRect = c.sliceRect ?? FULL_RECT;
  const setRect = (patch: Partial<SrcRect>) => onChange({ sliceRect: clampRect({ ...rect, ...patch }) });
  // Plugin content types (Spout, NDI, TRACKING) own their own inspector + discovery inside the
  // provider's `editor` (rendered below); the picker buttons just switch the core SourceType enum.
  const pickType = (type: SurfaceContent['type']) => onTypeChange(type);
  const onFile = (e: React.ChangeEvent<HTMLInputElement>, type: SourceType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const path = window.artlux?.getPathForFile?.(file);
    onChange({ type, url: path || URL.createObjectURL(file) });
  };

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        <Tooltip id="content.none">
          <button onClick={() => pickType(SourceType.NONE)} className={btnCls(c.type === SourceType.NONE)} {...help('content.none')}>
            <Slash size={16} className="mb-1" /><span className="text-micro">None</span>
          </button>
        </Tooltip>
        <Tooltip id="content.camera">
          <button onClick={() => pickType(SourceType.CAMERA)} className={btnCls(c.type === SourceType.CAMERA)} {...help('content.camera')}>
            <Video size={16} className="mb-1" /><span className="text-micro">Camera</span>
          </button>
        </Tooltip>
        {/* role="button"+tabIndex make the <label> keyboard-focusable (the global :focus-visible ring
            shows on it), and Enter/Space opens the hidden file input — a keyboard user could not reach
            these pickers before (the input is display:none, and a bare <label> isn't focusable). */}
        <Tooltip id="content.video">
          <label
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.click(); } }}
            className={`pressable relative cursor-pointer ${btnCls(c.type === SourceType.VIDEO)}`} {...help('content.video')}
          >
            <input type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e, SourceType.VIDEO)} />
            <Monitor size={16} className="mb-1" /><span className="text-micro">Video</span>
          </label>
        </Tooltip>
        <Tooltip id="content.image">
          <label
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.click(); } }}
            className={`pressable relative cursor-pointer ${btnCls(c.type === SourceType.IMAGE)}`} {...help('content.image')}
          >
            <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e, SourceType.IMAGE)} />
            <ImageIcon size={16} className="mb-1" /><span className="text-micro">Image</span>
          </label>
        </Tooltip>
        <Tooltip id="content.dmx-in">
          <button onClick={() => pickType(SourceType.DMX_IN)} className={btnCls(c.type === SourceType.DMX_IN)} title="Art-Net / sACN in" {...help('content.dmx-in')}>
            <Network size={16} className="mb-1" /><span className="text-micro">DMX In</span>
          </button>
        </Tooltip>
        <Tooltip id="content.spout">
          <button onClick={() => pickType(SourceType.SPOUT)} className={btnCls(c.type === SourceType.SPOUT)} {...help('content.spout')}>
            <Cast size={16} className="mb-1" /><span className="text-micro">Spout</span>
          </button>
        </Tooltip>
        <Tooltip id="content.ndi">
          <button onClick={() => pickType(SourceType.NDI)} className={btnCls(c.type === SourceType.NDI)} title="NDI network video" {...help('content.ndi')}>
            <Radio size={16} className="mb-1" /><span className="text-micro">NDI</span>
          </button>
        </Tooltip>
        <Tooltip id="content.effect">
          <button onClick={() => pickType('EFFECT')} className={btnCls(c.type === 'EFFECT')} {...help('content.effect')}>
            <Sparkles size={16} className="mb-1" /><span className="text-micro">Effect</span>
          </button>
        </Tooltip>
        {showLayerOption && (
          <Tooltip id="content.layer">
            <button onClick={() => pickType(SourceType.LAYER)} className={btnCls(c.type === SourceType.LAYER)} title="A single timeline track" {...help('content.layer')}>
              <Film size={16} className="mb-1" /><span className="text-micro">Layer</span>
            </button>
          </Tooltip>
        )}
        {showLayerOption && (
          <Tooltip id="content.timeline">
            <button onClick={() => pickType(SourceType.PROGRAM)} className={btnCls(c.type === SourceType.PROGRAM)} title="The whole timeline composited (all contributing layers)" {...help('content.timeline')}>
              <Clapperboard size={16} className="mb-1" /><span className="text-micro">Timeline</span>
            </button>
          </Tooltip>
        )}
        <Tooltip id="content.tracking">
          <button onClick={() => pickType(SourceType.TRACKING)} className={btnCls(c.type === SourceType.TRACKING)} title="LiDAR blob tracking (projection-mappable)" {...help('content.tracking')}>
            <Crosshair size={16} className="mb-1" /><span className="text-micro">Tracking</span>
          </button>
        </Tooltip>
        <Tooltip id="content.mediapipe">
          <button onClick={() => pickType(SourceType.MEDIAPIPE)} className={btnCls(c.type === SourceType.MEDIAPIPE)} title="Camera pose tracking (MediaPipe BlazePose)" {...help('content.mediapipe')}>
            <PersonStanding size={16} className="mb-1" /><span className="text-micro">MediaPipe</span>
          </button>
        </Tooltip>
        <Tooltip id="content.augmenta">
          <button onClick={() => pickType(SourceType.AUGMENTA)} className={btnCls(c.type === SourceType.AUGMENTA)} title="Augmenta box optical tracking (OSC)" {...help('content.augmenta')}>
            <Radar size={16} className="mb-1" /><span className="text-micro">Augmenta</span>
          </button>
        </Tooltip>
        {canSlice && (
          <Tooltip id="content.slice">
            <button onClick={() => pickType(SourceType.SLICE)} className={btnCls(c.type === SourceType.SLICE)}
              title="A cropped region of another surface — how one picture spans several projectors" {...help('content.slice')}>
              <Crop size={16} className="mb-1" /><span className="text-micro">Slice</span>
            </button>
          </Tooltip>
        )}
      </div>

      {canSlice && c.type === SourceType.SLICE && (
        <div className="space-y-1 pt-1">
          <div className="flex items-center gap-1">
            <label className="text-fg-2 w-12 text-micro">Of</label>
            <Tooltip id="content.slice-of">
              <select value={c.sliceOf ?? ''} onChange={(e) => onChange({ sliceOf: e.target.value })} {...help('content.slice-of')}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
                <option value="">— select a surface —</option>
                {sliceable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Tooltip>
          </div>
          {/* The crop, in fractions of the source picture. Set these by hand for a one-off; for a
              projector array use Outputs → Spans, which derives them AND the soft edges together. */}
          <div className="grid grid-cols-4 gap-1">
            {([['x', 'X'], ['y', 'Y'], ['w', 'W'], ['h', 'H']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1 text-micro text-fg-2">
                <span className="text-fg-3">{label}</span>
                <input type="number" step={0.01} min={0} max={1} value={+rect[k].toFixed(3)}
                  onChange={(e) => setRect({ [k]: +e.target.value } as Partial<SrcRect>)}
                  className="w-full min-w-0 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-right text-fg-1 num focus:border-accent focus:outline-none" />
              </label>
            ))}
          </div>
          {sliceable.length === 0 && <div className="text-micro text-fg-3 italic">No other surface to slice.</div>}
        </div>
      )}

      {c.type === SourceType.CAMERA && <CameraSettings content={c} onChange={onChange} />}

      {showLayerOption && c.type === SourceType.LAYER && (
        <div className="flex items-center gap-1 pt-1">
          <label className="text-fg-2 w-12 text-micro">Track</label>
          <Tooltip id="content.layer-track">
            <select value={c.layerId ?? ''} onChange={(e) => onChange({ layerId: e.target.value })} {...help('content.layer-track')}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
              <option value="">— select a track —</option>
              {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Tooltip>
        </div>
      )}

      {/* Plugin-contributed content types (Spout, NDI, …) render their own inspector + discovery here. */}
      {(() => {
        const Editor = contentSourceRegistry.get(c.type)?.editor;
        return Editor ? <Editor content={c} onChange={onChange} /> : null;
      })()}

      {c.type === 'EFFECT' && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between text-xs gap-2">
            <label className="text-fg-2 w-16 truncate">Effect</label>
            <Tooltip id="content.effect-select">
              <select value={c.effectId ?? 0} onChange={(e) => onChange({ effectId: parseInt(e.target.value) })} {...help('content.effect-select')}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
                {EFFECT_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
              </select>
            </Tooltip>
          </div>
          <div className="flex items-center justify-between text-xs gap-2">
            <label className="text-fg-2 w-16 truncate">Palette</label>
            <Tooltip id="content.palette-select">
              <select value={c.paletteId ?? 0} onChange={(e) => onChange({ paletteId: parseInt(e.target.value) })} {...help('content.palette-select')}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
                {PALETTE_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
              </select>
            </Tooltip>
          </div>
          <Slider label="Speed" value={c.speed ?? 0.5} min={0} max={1} step={0.01}
            format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ speed: v })} />
          <Slider label="Intensity" value={c.intensity ?? 0.5} min={0} max={1} step={0.01}
            format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ intensity: v })} />
        </div>
      )}

      {c.type === SourceType.TRACKING && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center gap-1">
            <label className="text-fg-2 w-12 text-micro">Source</label>
            <Tooltip id="content.tracking-source">
              <select value={c.trackingSource ?? 'SOL'} onChange={(e) => onChange({ trackingSource: e.target.value })} {...help('content.tracking-source')}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
                <option value="SOL">SOL — floor</option>
                <option value="MUR">MUR — wall</option>
                <option value="SOL_MUR">SOL_MUR — combined</option>
              </select>
            </Tooltip>
          </div>
          <div className="flex items-center gap-1">
            <label className="text-fg-2 w-12 text-micro" title="A timeline video layer drawn under the blobs (projects as one surface)">Background</label>
            <select value={c.bgLayerId ?? ''} onChange={(e) => onChange({ bgLayerId: e.target.value || undefined })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
              <option value="">— none —</option>
              {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <Slider label="Blob size" value={c.blobSize ?? 0.04} min={0.01} max={0.15} step={0.005}
            format={(v) => `${Math.round(v * 100)}%`} onInput={(v) => onChange({ blobSize: v })} onChange={(v) => onChange({ blobSize: v })} />
          <Slider label="Trail (s)" value={c.trailSeconds ?? 1.2} min={0} max={3} step={0.1}
            format={(v) => `${v.toFixed(1)}s`} onInput={(v) => onChange({ trailSeconds: v })} onChange={(v) => onChange({ trailSeconds: v })} />
          <div className="flex items-center gap-1">
            <label className="text-fg-2 w-12 text-micro">Rotate</label>
            <Tooltip id="content.tracking-rotate">
              <select value={c.rotate ?? 0} onChange={(e) => onChange({ rotate: parseInt(e.target.value) })} {...help('content.tracking-rotate')}
                className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none">
                {[0, 90, 180, 270].map((d) => <option key={d} value={d}>{d}°</option>)}
              </select>
            </Tooltip>
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-micro text-fg-2">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.flipH ?? false} onChange={(e) => onChange({ flipH: e.target.checked })} />Flip H</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.flipV ?? false} onChange={(e) => onChange({ flipV: e.target.checked })} />Flip V</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.showIds ?? false} onChange={(e) => onChange({ showIds: e.target.checked })} />Show IDs</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.calibration ?? false} onChange={(e) => onChange({ calibration: e.target.checked })} />Calibrate</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={c.trail !== false} onChange={(e) => onChange({ trail: e.target.checked })} />Trail</label>
          </div>
        </div>
      )}

      {c.type !== SourceType.NONE && (
        <div className="pt-2">
          <Slider label="Opacity" value={c.opacity ?? 1} min={0} max={1} step={0.01}
            format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => onChange({ opacity: v })} />
        </div>
      )}
    </>
  );
};

// Memoized: the renderer repaints per frame during playback, and a parent re-render would tear down an
// OPEN native <select> in this inspector (color order, effect, tracking source) mid-interaction — the
// documented drop-selection hazard. With stable props from the editor store, this now holds its ground.
export const ContentEditor = React.memo(ContentEditorImpl);
