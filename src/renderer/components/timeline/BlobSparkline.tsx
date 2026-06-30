import React, { useEffect, useRef, useState } from 'react';
import { trackingTake as take } from '@artlux/plugin-lidar-tracking';

interface Props {
  path: string;        // the take's .lblob sidecar
  inPoint: number;     // trim offset into the take (seconds)
  clipDuration: number;// visible window length (seconds)
  widthPx: number;
  heightPx: number;
}

// A blob-density signature for a tracking-take clip — the visual analogue of the video Filmstrip.
// Draws the take's per-bin active-blob count across the clip's trimmed window.
const BlobSparklineBase: React.FC<Props> = ({ path, inPoint, clipDuration, widthPx, heightPx }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tk, setTk] = useState(() => take.getCached(path) ?? null);

  useEffect(() => {
    const hit = take.getCached(path);
    if (hit) { setTk(hit); return; }
    let live = true;
    void take.ensureLoaded(path).then((t) => { if (live && t) setTk(t); });
    return () => { live = false; };
  }, [path]);

  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const w = Math.max(1, Math.floor(widthPx)), h = Math.max(1, Math.floor(heightPx));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const density = tk?.density;
    if (!density || !density.length || !tk || tk.duration <= 0) return;
    const max = Math.max(1, ...density);
    ctx.fillStyle = 'rgba(126, 211, 33, 0.45)'; // calm green — blob activity
    for (let x = 0; x < w; x++) {
      const tSec = inPoint + (x / w) * clipDuration;
      const bin = Math.min(density.length - 1, Math.max(0, Math.floor((tSec / tk.duration) * density.length)));
      const bh = Math.round((density[bin] / max) * (h - 2));
      if (bh > 0) ctx.fillRect(x, h - bh, 1, bh);
    }
  }, [tk, inPoint, clipDuration, widthPx, heightPx]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
};

export const BlobSparkline = React.memo(BlobSparklineBase);
