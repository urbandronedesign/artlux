import React, { useEffect, useRef, useState } from 'react';
import type { RenderStats } from '../../../shared/protocol';
import { perfMonitor } from '../services/perfMonitor';
import { uiPerfMonitor, type UiPerfStats } from '../services/uiPerfMonitor';

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
  const [ui, setUi] = useState<UiPerfStats | null>(null);
  const frameHist = useRef<number[]>([]);
  const workHist = useRef<number[]>([]);
  const blockHist = useRef<number[]>([]);

  useEffect(() => {
    const tick = () => {
      const next = perfMonitor.stats();
      const nextUi = uiPerfMonitor.stats();
      frameHist.current = [...frameHist.current, next.frameP50].slice(-HISTORY);
      workHist.current = [...workHist.current, next.workP50].slice(-HISTORY);
      blockHist.current = [...blockHist.current, nextUi.longTaskMs].slice(-HISTORY);
      setS(next);
      setUi(nextUi);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!s) return <div className="p-4 text-mini text-fg-3 italic">Collecting frame samples…</div>;

  // Same jank heuristics as the old HUD: any dropped frame, or a p99 interval past the ~60 fps budget.
  const janky = s.longFrames > 0 || s.frameP99 > 20;

  const Metric: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
    <div className="flex items-baseline justify-between gap-4 px-3 py-1.5 border-b border-line-2">
      <span className="text-micro uppercase tracking-wider text-fg-3">{label}</span>
      <span className={`num text-mini ${warn ? 'text-danger' : 'text-fg-1'}`}>{value}</span>
    </div>
  );

  return (
    <div className="h-full overflow-auto bg-surface-1 text-fg-1">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line-2">
        {/* Panel-header standard (design system §2.3): a title anchors the hierarchy — it must not be
            the 10px floor, the same size as its own body rows. */}
        <span className="text-xs font-semibold uppercase tracking-wider text-fg-1">Render Performance</span>
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

      {/* ── What the UI cost the frame loop ──
          The block above says a frame was late; this says whether the main thread was BLOCKED while
          it happened. While a long task runs, nothing else on the thread does — including the frame
          loop — so blocked time is the direct evidence for "the UI stalled the engine", and its
          absence is equally load-bearing evidence for the opposite. */}
      {ui && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-micro uppercase tracking-wider text-fg-3">UI cost</span>
            {!ui.longTaskSupported && (
              <span className="text-micro text-warn">long-task observer unavailable — figures below are not zero, they are unknown</span>
            )}
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[220px] flex-1 border border-line-1 rounded-md overflow-hidden bg-surface-0/40">
              <Metric label="blocked / s" value={`${fmt(ui.longTaskMs)} ms`} warn={ui.longTaskMs > 16} />
              <Metric label="long tasks / s" value={`${ui.longTasks}`} warn={ui.longTasks > 0} />
              <Metric label="worst task" value={`${fmt(ui.longTaskMaxMs)} ms`} warn={ui.longTaskMaxMs > 50} />
              <Metric label="react commits / s" value={ui.profiling ? `${ui.commits}` : 'off'} />
              <Metric label="react commit time" value={ui.profiling ? `${fmt(ui.commitMs)} ms` : 'off'} warn={ui.profiling && ui.commitMs > 16} />
            </div>
            <div className="min-w-[220px] flex-1 border border-line-1 rounded-md p-2 bg-surface-0/40">
              <div className="flex items-baseline justify-between mb-1">
                <span className="text-micro uppercase tracking-wider text-fg-3">Blocked time</span>
                <span className={`num text-micro ${ui.longTaskMs > 16 ? 'text-danger' : 'text-fg-2'}`}>{fmt(ui.longTaskMs)} ms/s</span>
              </div>
              <Spark data={blockHist.current} warn={ui.longTaskMs > 16} />
            </div>
          </div>

          {/* Per-region React commit attribution — heaviest first. This is what answers "did an
              unrelated App render just reconcile the Stage / the 3D scene / the timeline?". */}
          {ui.profiling && ui.regions.length > 0 && (
            <div className="mt-3 border border-line-1 rounded-md overflow-hidden bg-surface-0/40">
              {ui.regions.map((r) => (
                <Metric key={r.id} label={r.id} value={`${r.commits}× · ${fmt(r.totalMs)} ms · max ${fmt(r.maxMs)}`} warn={r.totalMs > 8} />
              ))}
            </div>
          )}
        </div>
      )}

      <p className="px-3 pb-3 text-micro text-fg-3 leading-relaxed">
        Frame = wall-clock between rendered frames (drops show as long frames). Work = time spent inside
        the Stage tick. Green when nominal; amber/red flags a dropped frame or a p99 past the 60 fps budget.
        {' '}Blocked = main-thread time lost to tasks over 50 ms, measured always. React commit timing is
        off by default because measuring it is not free — enable it with <span className="num">?uiperf=1</span>{' '}
        or <span className="num">localStorage['artlux.uiPerf']='1'</span>, then reload (it cannot be toggled
        live: that would remount the Stage and stop output).
      </p>
    </div>
  );
};

export default PerfPanel;
