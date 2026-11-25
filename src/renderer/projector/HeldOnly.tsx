import React, { useEffect, useState } from 'react';
import type { MainToProjector, ProjectorToMain } from './bridge';
import { outputTitle } from './outputTitle';
import { BadgeCanvas } from './ProjectorApp';
import { HeldPicture } from './HeldPicture';

// E6h — WHAT A PROJECTOR WINDOW SHOWS ACROSS AN ENGINE DEATH when it draws nothing of its own (the test hook
// ARTLUX_NO_APP_PROJECTOR=1 today; with no browser engine, E6i, every window). Black, and — handed by main the moment
// the engine dies (engineHost.holdProjectors) — the engine's last picture of this output, 1:1 in device pixels (the
// engine's raster IS this window's drawing size), until main drops it when a restarted engine shows the output again.
export const HeldOnly: React.FC = () => {
  // A WINDOWED output wears the badge over its picture — the engine draws it on its window, not into the raster it
  // keeps, so the held picture needs it here exactly as ProjectorApp draws it (the one bitmap, BadgeCanvas).
  const [badge, setBadge] = useState<string | null>(null);
  // The bridge, for what this window still IS without drawing: its title (the engine's windowed output copies it),
  // and the receipts main's frame streams wait on — every streamed bitmap acknowledged and released at once.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (!d || d.kind !== 'artlux:projector-port' || !e.ports[0]) return;
      const port = e.ports[0];
      port.onmessage = (ev: MessageEvent) => {
        const m = ev.data as MainToProjector;
        if ((m.t === 'frame' || m.t === 'layerFrame' || m.t === 'surfaceFrame') && m.ack) (port.postMessage as (x: ProjectorToMain) => void)({ t: 'frameAck', key: m.ack });
        const bmp = (m as { bitmap?: ImageBitmap }).bitmap;
        if (bmp && typeof bmp.close === 'function') bmp.close();
        if (m.t === 'config') {
          const label = m.identity?.label || m.surface.name;
          document.title = outputTitle(label, m.identity?.display);
          setBadge(m.identity?.windowed ? label : null);
        }
      };
      port.start();
      (port.postMessage as (x: ProjectorToMain) => void)({ t: 'ready' });   // main (re)sends config on it
    };
    window.addEventListener('message', onMsg);
    window.postMessage('artlux:projector-ready', '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', overflow: 'hidden', cursor: 'none' }}>
      <HeldPicture />
      {badge !== null && <BadgeCanvas name={badge} />}
    </div>
  );
};
