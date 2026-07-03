import React, { useEffect, useState } from 'react';
import type { RenderStats } from '../../../shared/protocol';
import { perfMonitor } from '../services/perfMonitor';

// Debug overlay for the renderer frame-time signal (services/perfMonitor). Mounted in the editor only
// when the perf flag is on (`?perf=1`, or the Ctrl+Alt+P toggle in App). Polls stats ~1 Hz on its own
// timer so it never re-renders the app; broadcast mode has no chrome and relies on the console line +
// Prometheus gauges instead. This is a diagnostic surface, not product UI — hence the plain styling.

const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

export const PerfHud: React.FC = () => {
  const [s, setS] = useState<RenderStats | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setS(perfMonitor.stats()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!s) return null;

  // Flag jank: any long (dropped) frame in the window, or a p99 interval well past ~60 fps budget.
  const janky = s.longFrames > 0 || s.frameP99 > 20;
  const row = (label: string, value: string, warn = false) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color: warn ? '#ff6b6b' : '#e6f0ff', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed', bottom: 40, right: 12, zIndex: 60,
        minWidth: 190, padding: '10px 12px',
        background: 'rgba(12,16,24,0.86)', border: '1px solid rgba(120,150,200,0.28)',
        borderRadius: 8, backdropFilter: 'blur(6px)',
        font: '11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e6f0ff',
        pointerEvents: 'none', userSelect: 'none',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6, letterSpacing: 0.4, color: janky ? '#ffb454' : '#7fd1ff' }}>
        RENDER PERF {janky ? '⚠' : ''}
      </div>
      {row('fps', fmt(s.fps))}
      {row('frame p50', `${fmt(s.frameP50)} ms`)}
      {row('frame p99', `${fmt(s.frameP99)} ms`, s.frameP99 > 20)}
      {row('frame max', `${fmt(s.frameMax)} ms`, s.frameMax > 33)}
      {row('work p50', `${fmt(s.workP50)} ms`)}
      {row('work p99', `${fmt(s.workP99)} ms`, s.workP99 > 12)}
      {row('long frames', `${s.longFrames} / ${s.samples}`, s.longFrames > 0)}
    </div>
  );
};

export default PerfHud;
