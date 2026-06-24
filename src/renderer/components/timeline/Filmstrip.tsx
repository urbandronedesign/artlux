import React, { useEffect, useRef } from 'react';
import { getThumb, onThumb } from '../../services/thumbnailCache';

interface Props {
  path: string;
  inPoint: number;
  clipDuration: number;
  widthPx: number;
  heightPx: number;
}

// Imperative <canvas> filmstrip: paints video-frame thumbnails across a clip. Fully decoupled
// from React render — it repaints on prop change and whenever a requested thumbnail becomes
// ready (onThumb). Thumbnails come from the cache, which decodes async without touching playback.
export const Filmstrip: React.FC<Props> = ({ path, inPoint, clipDuration, widthPx, heightPx }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.max(1, Math.round(widthPx));
    const h = Math.max(1, Math.round(heightPx));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const paint = () => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const slotW = Math.max(48, Math.round(h * 16 / 9));
      const count = Math.max(1, Math.min(40, Math.floor(w / slotW)));
      const step = w / count;
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < count; i++) {
        const f = (i + 0.5) / count;
        const srcTime = inPoint + f * clipDuration;
        const bmp = getThumb(path, srcTime);
        const x = Math.round(i * step);
        const sw = Math.ceil(step) + 1;
        if (bmp) {
          // cover-fit the thumbnail into the slot
          const scale = Math.max(sw / bmp.width, h / bmp.height);
          const dw = bmp.width * scale, dh = bmp.height * scale;
          ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, x + (sw - dw) / 2, (h - dh) / 2, dw, dh);
        }
        if (i > 0) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x, 0, 1, h); }
      }
    };

    const schedule = () => {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; paint(); });
    };
    schedule();
    const off = onThumb((p) => { if (p === path) schedule(); });
    return () => { off(); if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; } };
  }, [path, inPoint, clipDuration, widthPx, heightPx]);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />;
};
