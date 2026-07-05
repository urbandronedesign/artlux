import React, { useEffect, useRef, useState } from 'react';
import type { RenderStats } from '../../../shared/protocol';
import { perfMonitor } from '../services/perfMonitor';

// Docked Performance pane (bottom-dock "Performance" tab) — the proper home for the renderer
// frame-time signal from services/perfMonitor, replacing the old floating PerfHud overlay. Polls
// stats ~1 Hz on its own timer so it never re-renders the App, keeps a short rolling history for the
// sparklines, and styles everything with the app design tokens (surface / line / fg / ok-warn-danger)
// so it reads as console chrome, not a debug box. Broadcast mode has no chrome and relies on the
// console line + Prometheus gauges instead.

const HISTORY = 60; // ~1 minute of 1 Hz samples behind the sparklines
const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

// Minimal dependency-free sparkline: a normalized polyline over a fixed viewBox, scaled to the
// series max (with a small floor so a flat-low series doesn't blow up). `warn` recolors the trace.
const Spark: React.FC<{ data: number[]; warn?: boolean }> = ({ data, warn }) => {
  const w = 120, h = 28;
  if (data.length < 2) return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" />;
  const max = Math.max(1, ...data);
  const step = w / (HISTORY - 1);
  // Right-align the newest sample; pad the left when the window isn't full yet.
  const offset = HISTORY - data.length;
  const pts = data.map((v, i) => `${((i + offset) * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(' ');
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block">
      <polyline
        points={pts}
        fill="none"
        stroke={warn ? 'var(--danger)' : 'var(--accent)'}
        strokeWidth={1.25}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
};

export const PerfPanel: React.FC = () => {
  const [s, setS] = useState<RenderStats | null>(null);
  const frameHist = useRef<number[]>([]);
  const workHist = useRef<number[]>([]);

  useEffect(() => {
    const tick = () => {
      const next = perfMonitor.stats();
      frameHist.current = [...frameHist.current, next.frameP50].slice(-HISTORY);
      workHist.current = [...workHist.current, next.workP50].slice(-HISTORY);
      setS(next);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!s) return <div className="p-4 text-mini text-fg-3 italic">Collecting frame samples…</div>;

  // Same jank heuristics as the old HUD: any dropped frame, or a p99 interval past the ~60 fps budget.
  const janky = s.longFrames > 0 || s.frameP99 > 20;

  const Metric: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
    <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 border-b border-line-1/60">
      <span className="text-micro uppercase tracking-wider text-fg-3">{label}</span>
      <span className={`num text-mini ${warn ? 'text-danger' : 'text-fg-1'}`}>{value}</span>
    </div>
  );

  return (
    <div className="h-full overflow-auto bg-surface-1 text-fg-1">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-1">
        <span className="text-micro font-bold uppercase tracking-wider text-fg-2">Render Performance</span>
        <span className={`text-micro font-bold ${janky ? 'text-warn' : 'text-ok'}`}>
          {janky ? '⚠ jank' : 'nominal'}
        </span>
        <span className="ml-auto num text-mini text-fg-2">{fmt(s.fps)} fps</span>
      </div>

      {/* Two-column layout: the numeric table on the left, trend sparklines on the right. Wraps on
          narrow docks so nothing clips. */}
      <div className="flex flex-wrap gap-4 p-3">
        <div className="min-w-[220px] flex-1 border border-line-1 rounded-md overflow-hidden bg-surface-0/40">
          <Metric label="fps" value={fmt(s.fps)} />
          <Metric label="frame p50" value={`${fmt(s.frameP50)} ms`} />
          <Metric label="frame p99" value={`${fmt(s.frameP99)} ms`} warn={s.frameP99 > 20} />
          <Metric label="frame max" value={`${fmt(s.frameMax)} ms`} warn={s.frameMax > 33} />
          <Metric label="work p50" value={`${fmt(s.workP50)} ms`} />
          <Metric label="work p99" value={`${fmt(s.workP99)} ms`} warn={s.workP99 > 12} />
          <Metric label="long frames" value={`${s.longFrames} / ${s.samples}`} warn={s.longFrames > 0} />
        </div>

        <div className="min-w-[220px] flex-1 space-y-3">
          <div className="border border-line-1 rounded-md p-2 bg-surface-0/40">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-micro uppercase tracking-wider text-fg-3">Frame time (p50)</span>
              <span className={`num text-micro ${s.frameP99 > 20 ? 'text-danger' : 'text-fg-2'}`}>{fmt(s.frameP50)} ms</span>
            </div>
            <Spark data={frameHist.current} warn={s.frameP99 > 20} />
          </div>
          <div className="border border-line-1 rounded-md p-2 bg-surface-0/40">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-micro uppercase tracking-wider text-fg-3">Work time (p50)</span>
              <span className={`num text-micro ${s.workP99 > 12 ? 'text-danger' : 'text-fg-2'}`}>{fmt(s.workP50)} ms</span>
            </div>
            <Spark data={workHist.current} warn={s.workP99 > 12} />
          </div>
        </div>
      </div>

      <p className="px-3 pb-3 text-micro text-fg-3 leading-relaxed">
        Frame = wall-clock between rendered frames (drops show as long frames). Work = time spent inside
        the Stage tick. Green when nominal; amber/red flags a dropped frame or a p99 past the 60 fps budget.
      </p>
    </div>
  );
};

export default PerfPanel;
