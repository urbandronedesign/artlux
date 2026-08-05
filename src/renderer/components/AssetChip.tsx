import React, { useEffect, useRef, useState } from 'react';
import { Box, Film, Image as ImageIcon, Radio, Music, AlertTriangle } from 'lucide-react';
import { AssetEntry, MediaView } from '../types';
import { getThumb, onThumb } from '../services/thumbnailCache';
import { resolveMediaUrl } from '../services/mediaCache';
import { BlobSparkline } from './timeline/BlobSparkline';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';

// Single-frame video thumbnail (decoupled from playback via thumbnailCache).
const VideoThumb: React.FC<{ path: string }> = ({ path }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const paint = () => {
      const ctx = cv.getContext('2d'); if (!ctx) return;
      const bmp = getThumb(path, 0.5);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (bmp) {
        const s = Math.max(cv.width / bmp.width, cv.height / bmp.height);
        const dw = bmp.width * s, dh = bmp.height * s;
        ctx.drawImage(bmp, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
      }
    };
    paint();
    const off = onThumb((p) => { if (p === path) paint(); });
    return () => off();
  }, [path]);
  return <canvas ref={ref} width={160} height={90} className="w-full h-full object-cover" />;
};

// Streams via artlux-media:// — no state, no effect, no whole-file read. A library of 300 images used
// to mean 300 full-resolution files pulled into renderer memory over IPC just to fill 74px tiles.
const ImageThumb: React.FC<{ path: string }> = ({ path }) => (
  <img src={resolveMediaUrl(path)} alt="" className="w-full h-full object-cover" />
);

interface Props {
  asset: AssetEntry;
  usageCount: number;
  missing: boolean;
  selected?: boolean;
  /** Explorer-style density. 'large'/'medium' are the same tile at different grid widths; 'list' is a row. */
  view?: MediaView;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

// The type glyph, shared by the tile and the row.
const TypeGlyph: React.FC<{ type: AssetEntry['type']; size: number }> = ({ type, size }) => (
  type === 'video' ? <Film size={size} /> : type === 'image' ? <ImageIcon size={size} />
    : type === 'take' ? <Radio size={size} /> : type === 'audio' ? <Music size={size} /> : <Box size={size} />
);

// The preview itself, sized by its container. `px` is what the canvas-backed previews rasterise at
// (they take pixel dimensions, not CSS) — the row passes a small one so a 300-asset list isn't 300
// full-size canvases.
const Preview: React.FC<{ asset: AssetEntry; px: { w: number; h: number }; iconSize: number }> = ({ asset, px, iconSize }) => (
  <>
    {asset.type === 'video' && <VideoThumb path={asset.path} />}
    {asset.type === 'image' && <ImageThumb path={asset.path} />}
    {asset.type === 'take' && <BlobSparkline path={asset.path} inPoint={0} clipDuration={asset.durationSec ?? 1} widthPx={px.w} heightPx={px.h} />}
    {asset.type === 'model' && <Box size={iconSize} className="text-fg-3" />}
    {asset.type === 'audio' && <Music size={iconSize} className="text-fg-3" />}
  </>
);

// A draggable media entry. Drag carries 'application/artlux-asset' (and 'application/artlux-take'
// for takes, so the timeline's tracking-lane drop keeps working).
//
// Two shapes, one behaviour: a TILE (large/medium icons — the grid decides how wide, so both sizes
// share this markup) and a ROW (list view, for reading many names at once). The drag payload,
// title, selection and missing/usage semantics are identical in both — only the layout differs.
export const AssetChip: React.FC<Props> = ({ asset, usageCount, missing, selected, view = 'medium', onClick, onDoubleClick, onContextMenu }) => {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/artlux-asset', JSON.stringify({ id: asset.id, type: asset.type, path: asset.path }));
    if (asset.type === 'take') e.dataTransfer.setData('application/artlux-take', asset.id);
    e.dataTransfer.effectAllowed = 'copy';
  };
  // Same handlers/affordances whichever shape renders.
  const common = {
    draggable: !missing,
    onDragStart, onClick, onDoubleClick, onContextMenu,
    title: `${asset.name}${missing ? ' — missing on disk' : ''} · ${usageCount ? `used ${usageCount}×` : 'unused'}`,
  };

  if (view === 'list') {
    return (
      <Tooltip id="media.asset-chip">
      <div {...common} {...help('media.asset-chip')}
        className={`group relative flex items-center gap-2 pr-1.5 rounded-sm border overflow-hidden cursor-grab ${selected ? 'border-accent bg-surface-2' : 'border-transparent hover:bg-surface-2'} ${missing ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <div className="relative w-12 h-7 shrink-0 bg-surface-0 flex items-center justify-center overflow-hidden rounded-sm">
          <Preview asset={asset} px={{ w: 96, h: 56 }} iconSize={14} />
        </div>
        {/* Only where the preview isn't already the type icon — a model/audio row would otherwise
            carry the same glyph twice, side by side. */}
        {(asset.type === 'video' || asset.type === 'image' || asset.type === 'take') && (
          <span className="text-fg-2/90 shrink-0"><TypeGlyph type={asset.type} size={11} /></span>
        )}
        <span className="text-micro text-fg-1 truncate flex-1 min-w-0">{asset.name}</span>
        {missing ? <span className="text-warn shrink-0" title="Missing on disk"><AlertTriangle size={12} /></span> : (
          <span className={`text-micro px-1 rounded shrink-0 ${usageCount ? 'bg-accent/80 text-black' : 'text-fg-3'}`}>
            {usageCount ? `×${usageCount}` : 'unused'}
          </span>
        )}
      </div>
      </Tooltip>
    );
  }

  const small = view === 'medium';
  return (
    <Tooltip id="media.asset-chip">
    <div {...common} {...help('media.asset-chip')}
      className={`group relative flex flex-col rounded-sm border overflow-hidden cursor-grab ${selected ? 'border-accent' : 'border-line-2 hover:border-line-2/80'} ${missing ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      <div className="relative w-full aspect-video bg-surface-0 flex items-center justify-center">
        <Preview asset={asset} px={{ w: 160, h: 90 }} iconSize={small ? 20 : 26} />
        {/* type glyph */}
        <span className="absolute top-1 left-1 text-fg-2/90 drop-shadow"><TypeGlyph type={asset.type} size={11} /></span>
        {missing && <span className="absolute top-1 right-1 text-warn" title="Missing on disk"><AlertTriangle size={12} /></span>}
        {/* At medium the tile is ~half as wide, so the 'unused' pill would cover the frame it labels —
            show the pill only when there is a count to report. Unused stays readable from the badge's
            absence plus the tooltip, and the large view still spells it out. */}
        {!missing && (usageCount > 0 || !small) && (
          <span className={`absolute bottom-1 right-1 text-micro px-1 rounded ${usageCount ? 'bg-accent/80 text-black' : 'bg-surface-2 text-fg-3'}`}>
            {usageCount ? `×${usageCount}` : 'unused'}
          </span>
        )}
      </div>
      <div className="px-1.5 py-1 text-micro leading-tight truncate text-fg-1 bg-surface-2">{asset.name}</div>
    </div>
    </Tooltip>
  );
};
