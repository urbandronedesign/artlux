import React, { useEffect, useRef, useState } from 'react';
import { Box, Film, Image as ImageIcon, Radio, AlertTriangle } from 'lucide-react';
import { AssetEntry } from '../types';
import { getThumb, onThumb } from '../services/thumbnailCache';
import { ensureBlobUrl, mimeForPath } from '../services/mediaCache';
import { BlobSparkline } from './timeline/BlobSparkline';

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

const ImageThumb: React.FC<{ path: string }> = ({ path }) => {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => { let live = true; void ensureBlobUrl(path, mimeForPath(path)).then(u => { if (live) setUrl(u); }); return () => { live = false; }; }, [path]);
  return url ? <img src={url} alt="" className="w-full h-full object-cover" /> : null;
};

interface Props {
  asset: AssetEntry;
  usageCount: number;
  missing: boolean;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

// A draggable media tile. Drag carries 'application/artlux-asset' (and 'application/artlux-take'
// for takes, so the timeline's tracking-lane drop keeps working).
export const AssetChip: React.FC<Props> = ({ asset, usageCount, missing, selected, onClick, onDoubleClick, onContextMenu }) => {
  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/artlux-asset', JSON.stringify({ id: asset.id, type: asset.type, path: asset.path }));
    if (asset.type === 'take') e.dataTransfer.setData('application/artlux-take', asset.id);
    e.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div
      draggable={!missing}
      onDragStart={onDragStart}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={`${asset.name}${missing ? ' — missing on disk' : ''} · ${usageCount ? `used ${usageCount}×` : 'unused'}`}
      className={`group relative flex flex-col rounded-[var(--r-sm)] border overflow-hidden cursor-grab ${selected ? 'border-accent' : 'border-line-2 hover:border-line-2/80'} ${missing ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      <div className="relative w-full aspect-video bg-surface-0 flex items-center justify-center">
        {asset.type === 'video' && <VideoThumb path={asset.path} />}
        {asset.type === 'image' && <ImageThumb path={asset.path} />}
        {asset.type === 'take' && <BlobSparkline path={asset.path} inPoint={0} clipDuration={asset.durationSec ?? 1} widthPx={160} heightPx={90} />}
        {asset.type === 'model' && <Box size={26} className="text-fg-3" />}
        {/* type glyph */}
        <span className="absolute top-1 left-1 text-fg-2/90 drop-shadow">
          {asset.type === 'video' ? <Film size={11} /> : asset.type === 'image' ? <ImageIcon size={11} /> : asset.type === 'take' ? <Radio size={11} /> : <Box size={11} />}
        </span>
        {missing && <span className="absolute top-1 right-1 text-warn" title="Missing on disk"><AlertTriangle size={12} /></span>}
        {!missing && (
          <span className={`absolute bottom-1 right-1 text-[8px] px-1 rounded ${usageCount ? 'bg-accent/80 text-black' : 'bg-surface-2 text-fg-3'}`}>
            {usageCount ? `×${usageCount}` : 'unused'}
          </span>
        )}
      </div>
      <div className="px-1.5 py-1 text-[10px] leading-tight truncate text-fg-1 bg-surface-2">{asset.name}</div>
    </div>
  );
};
