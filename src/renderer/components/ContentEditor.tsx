import React, { useEffect, useState } from 'react';
import { SurfaceContent, SourceType, VideoLayer } from '../types';
import { Monitor, Image as ImageIcon, Video, Sparkles, Network, Cast, Radio, RefreshCw, Slash, Film, Clapperboard, Crosshair } from 'lucide-react';
import { Slider } from './ui';
import { EFFECT_NAMES } from '../gpu/effects';
import { PALETTE_NAMES } from '../gpu/palettes';
import { listSpoutSenders } from '../services/spoutReceiver';
import { listNdiSources, ndiAvailable } from '../services/ndiReceiver';

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
}

const btnCls = (active: boolean) =>
  `flex flex-col items-center justify-center p-2 rounded border transition-all ${active ? 'bg-sel-surface/10 border-sel-surface text-sel-surface' : 'bg-surface-2 border-line-1 text-fg-2 hover:bg-surface-3'}`;

export const ContentEditor: React.FC<ContentEditorProps> = ({ content: c, onChange, onTypeChange, layers, showLayerOption = true }) => {
  const [spoutSenders, setSpoutSenders] = useState<string[]>([]);
  const [ndiSources, setNdiSources] = useState<string[]>([]);
  const [ndiOk, setNdiOk] = useState(true);
  const refreshSpout = async () => setSpoutSenders(await listSpoutSenders());
  const refreshNdi = async () => { setNdiOk(await ndiAvailable()); setNdiSources(await listNdiSources()); };

  // Populate the sender/source lists when those types are shown.
  useEffect(() => { if (c.type === SourceType.SPOUT) void refreshSpout(); if (c.type === SourceType.NDI) void refreshNdi(); }, [c.type]);

  const pickType = (type: SurfaceContent['type']) => {
    onTypeChange(type);
    if (type === SourceType.SPOUT) void refreshSpout();
    if (type === SourceType.NDI) void refreshNdi();
  };
  const onFile = (e: React.ChangeEvent<HTMLInputElement>, type: SourceType) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const path = window.artlux?.getPathForFile?.(file);
    onChange({ type, url: path || URL.createObjectURL(file) });
  };

  return (
    <>
      <div className="grid grid-cols-3 gap-1">
        <button onClick={() => pickType(SourceType.NONE)} className={btnCls(c.type === SourceType.NONE)}>
          <Slash size={16} className="mb-1" /><span className="text-[9px]">None</span>
        </button>
        <button onClick={() => pickType(SourceType.CAMERA)} className={btnCls(c.type === SourceType.CAMERA)}>
          <Video size={16} className="mb-1" /><span className="text-[9px]">Camera</span>
        </button>
        <label className={`relative cursor-pointer ${btnCls(c.type === SourceType.VIDEO)}`}>
          <input type="file" accept="video/*" className="hidden" onChange={(e) => onFile(e, SourceType.VIDEO)} />
          <Monitor size={16} className="mb-1" /><span className="text-[9px]">Video</span>
        </label>
        <label className={`relative cursor-pointer ${btnCls(c.type === SourceType.IMAGE)}`}>
          <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e, SourceType.IMAGE)} />
          <ImageIcon size={16} className="mb-1" /><span className="text-[9px]">Image</span>
        </label>
        <button onClick={() => pickType(SourceType.DMX_IN)} className={btnCls(c.type === SourceType.DMX_IN)} title="Art-Net / sACN in">
          <Network size={16} className="mb-1" /><span className="text-[9px]">DMX In</span>
        </button>
        <button onClick={() => pickType(SourceType.SPOUT)} className={btnCls(c.type === SourceType.SPOUT)}>
          <Cast size={16} className="mb-1" /><span className="text-[9px]">Spout</span>
        </button>
        <button onClick={() => pickType(SourceType.NDI)} className={btnCls(c.type === SourceType.NDI)} title="NDI network video">
          <Radio size={16} className="mb-1" /><span className="text-[9px]">NDI</span>
        </button>
        <button onClick={() => pickType('EFFECT')} className={btnCls(c.type === 'EFFECT')}>
          <Sparkles size={16} className="mb-1" /><span className="text-[9px]">Effect</span>
        </button>
        {showLayerOption && (
          <button onClick={() => pickType(SourceType.LAYER)} className={btnCls(c.type === SourceType.LAYER)} title="A single timeline track">
            <Film size={16} className="mb-1" /><span className="text-[9px]">Layer</span>
          </button>
        )}
        {showLayerOption && (
          <button onClick={() => pickType(SourceType.PROGRAM)} className={btnCls(c.type === SourceType.PROGRAM)} title="The whole timeline composited (all contributing layers)">
            <Clapperboard size={16} className="mb-1" /><span className="text-[9px]">Timeline</span>
          </button>
        )}
        <button onClick={() => pickType(SourceType.TRACKING)} className={btnCls(c.type === SourceType.TRACKING)} title="LiDAR blob tracking (projection-mappable)">
          <Crosshair size={16} className="mb-1" /><span className="text-[9px]">Tracking</span>
        </button>
      </div>

      {showLayerOption && c.type === SourceType.LAYER && (
        <div className="flex items-center gap-1 pt-1">
          <label className="text-fg-2 w-12 text-[10px]">Track</label>
          <select value={c.layerId ?? ''} onChange={(e) => onChange({ layerId: e.target.value })}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
            <option value="">— select a track —</option>
            {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}

      {c.type === SourceType.SPOUT && (
        <div className="flex items-center gap-1 pt-1">
          <select value={c.spoutName ?? ''} onChange={(e) => onChange({ spoutName: e.target.value })}
            className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
            <option value="">Active sender</option>
            {spoutSenders.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button onClick={refreshSpout} title="Refresh Spout senders" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
        </div>
      )}

      {c.type === SourceType.NDI && (
        <div className="pt-1 space-y-1">
          <div className="flex items-center gap-1">
            <select value={c.ndiName ?? ''} onChange={(e) => onChange({ ndiName: e.target.value })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
              <option value="">First source</option>
              {ndiSources.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={refreshNdi} title="Refresh NDI sources" className="p-1.5 rounded border border-line-1 text-fg-2 hover:bg-surface-3"><RefreshCw size={12} /></button>
          </div>
          {!ndiOk && (
            <div className="text-[9px] text-warn">
              NDI runtime not found.{' '}
              <button onClick={() => window.artlux?.openExternal?.('https://ndi.video/tools/')} className="underline hover:text-fg-1">Install NDI Tools ↗</button>
            </div>
          )}
        </div>
      )}

      {c.type === 'EFFECT' && (
        <div className="space-y-3 pt-1">
          <div className="flex items-center justify-between text-xs gap-2">
            <label className="text-fg-2 w-16 truncate">Effect</label>
            <select value={c.effectId ?? 0} onChange={(e) => onChange({ effectId: parseInt(e.target.value) })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
              {EFFECT_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
            </select>
          </div>
          <div className="flex items-center justify-between text-xs gap-2">
            <label className="text-fg-2 w-16 truncate">Palette</label>
            <select value={c.paletteId ?? 0} onChange={(e) => onChange({ paletteId: parseInt(e.target.value) })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 focus:border-accent focus:outline-none">
              {PALETTE_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
            </select>
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
            <label className="text-fg-2 w-12 text-[10px]">Source</label>
            <select value={c.trackingSource ?? 'SOL'} onChange={(e) => onChange({ trackingSource: e.target.value })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
              <option value="SOL">SOL — floor</option>
              <option value="MUR">MUR — wall</option>
              <option value="SOL_MUR">SOL_MUR — combined</option>
            </select>
          </div>
          <div className="flex items-center gap-1">
            <label className="text-fg-2 w-12 text-[10px]" title="A timeline video layer drawn under the blobs (projects as one surface)">Background</label>
            <select value={c.bgLayerId ?? ''} onChange={(e) => onChange({ bgLayerId: e.target.value || undefined })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
              <option value="">— none —</option>
              {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
          <Slider label="Blob size" value={c.blobSize ?? 0.04} min={0.01} max={0.15} step={0.005}
            format={(v) => `${Math.round(v * 100)}%`} onInput={(v) => onChange({ blobSize: v })} onChange={(v) => onChange({ blobSize: v })} />
          <Slider label="Trail (s)" value={c.trailSeconds ?? 1.2} min={0} max={3} step={0.1}
            format={(v) => `${v.toFixed(1)}s`} onInput={(v) => onChange({ trailSeconds: v })} onChange={(v) => onChange({ trailSeconds: v })} />
          <div className="flex items-center gap-1">
            <label className="text-fg-2 w-12 text-[10px]">Rotate</label>
            <select value={c.rotate ?? 0} onChange={(e) => onChange({ rotate: parseInt(e.target.value) })}
              className="flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[10px] focus:border-accent focus:outline-none">
              {[0, 90, 180, 270].map((d) => <option key={d} value={d}>{d}°</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-1.5 text-[10px] text-fg-2">
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
