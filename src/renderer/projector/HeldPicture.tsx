import React, { useEffect, useRef, useState } from 'react';

// E6h / E6i step 3 — THE ENGINE'S LAST PICTURE OF THIS OUTPUT, handed by main the moment an engine that showed it
// dies (engineHost.holdProjectors), 1:1 in device pixels (the engine's raster IS this window's drawing size), until
// main drops it (a restarted engine shows the output again, or an emergency gives it back to the app's drawing).
// Over everything the window draws (it does not draw meanwhile — covered), under a windowed output's badge.
export const HeldPicture: React.FC = () => {
  const ref = useRef<HTMLCanvasElement>(null);
  const [on, setOn] = useState(false);
  useEffect(() => window.artlux?.onProjectorHeld?.((held) => {
    const c = ref.current;
    if (!c) return;
    if (!held) { c.width = 1; c.height = 1; c.getContext('2d')?.clearRect(0, 0, 1, 1); setOn(false); return; }
    c.width = held.w; c.height = held.h;
    const img = new ImageData(new Uint8ClampedArray(held.data.buffer, held.data.byteOffset, held.data.byteLength), held.w, held.h);
    c.getContext('2d')?.putImageData(img, 0, 0);
    setOn(true);
  }), []);
  return <canvas ref={ref} width={1} height={1} style={{ position: 'absolute', left: 0, top: 0, width: '100vw', height: '100vh', imageRendering: 'pixelated', background: '#000', display: on ? 'block' : 'none', pointerEvents: 'none' }} />;
};
