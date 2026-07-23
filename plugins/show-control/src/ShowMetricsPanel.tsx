import React, { useEffect, useRef, useState } from 'react';
import { Activity, ShieldCheck } from 'lucide-react';
import type { PanelProps } from '@artlux/sdk/renderer';
import type { MetricsSnapshot } from './types';
import { getIpc } from './showControlHost';

// The same metrics the tablet's Metrics tab shows, on the desktop: output engine, renderer frame-time,
// and the main process (CPU / RSS / heap / event-loop lag), plus the watchdog's recent self-heals.
//
// One assembler, two consumers — main builds this snapshot for the SSE stream and we pull the exact
// same payload. Pulled only while this panel is MOUNTED, so it costs nothing when nobody is looking
// (the sampler is read on demand, matching the tablet's "only while a client is watching" rule).

const N = 60; // ~1 minute of history at 1 Hz

const Spark: React.FC<{ data: number[]; max?: number; className?: string }> = ({ data, max, className }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w > 0 && h > 0 && (cv.width !== w || cv.height !== h)) { cv.width = w; cv.height = h; }
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (data.length < 2) return;
    const hi = Math.max(max ?? 0, ...data, 1);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (N - 1)) * cv.width;
      const y = cv.height - (v / hi) * (cv.height - 2) - 1;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#27b6c4'; ctx.lineWidth = 1.5; ctx.stroke();
  }, [data, max]);
  return <canvas ref={ref} className={`w-full h-8 ${className ?? ''}`} />;
};

const Stat: React.FC<{ label: string; value: string; series: number[]; max?: number; warn?: boolean }> =
({ label, value, series, max, warn }) => (
  <div className="rounded border border-line-1 bg-surface-2 p-2">
    <div className="flex items-baseline justify-between">
      <span className="text-micro uppercase tracking-wider text-fg-3">{label}</span>
      <span className={`num text-sm font-bold ${warn ? 'text-warn' : 'text-fg-1'}`}>{value}</span>
    </div>
    <Spark data={series} max={max} />
  </div>
);

export const ShowMetricsPanel: React.FC<PanelProps> = () => {
  const ipc = getIpc();
  const [m, setM] = useState<MetricsSnapshot | null>(null);
  const [hist, setHist] = useState<Record<string, number[]>>({ fps: [], pps: [], rfps: [], cpu: [], heap: [], lag: [] });

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const snap = await ipc?.invoke('showctl:metrics-get') as MetricsSnapshot | undefined;
      if (!live || !snap) return;
      setM(snap);
      setHist((h) => {
        const push = (a: number[], v: number) => [...a, Number.isFinite(v) ? v : 0].slice(-N);
        return {
          fps: push(h.fps, snap.engine?.fps ?? 0),
          pps: push(h.pps, snap.engine?.pps ?? 0),
          rfps: push(h.rfps, snap.render?.fps ?? 0),
          cpu: push(h.cpu, snap.system?.cpuPct ?? 0),
          heap: push(h.heap, snap.system?.heapMB ?? 0),
          lag: push(h.lag, snap.system?.eventLoopLagP99Ms ?? 0),
        };
      });
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => { live = false; clearInterval(t); };
  }, [ipc]);

  if (!m) return <div className="h-full flex items-center justify-center text-fg-3 text-mini italic">Waiting for metrics…</div>;

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3 text-xs">
      <div className="flex items-center gap-1.5 text-fg-2">
        <Activity size={13} className="text-accent" />
        <span className="text-mini font-semibold uppercase tracking-wider">Metrics</span>
        <span className="text-micro text-fg-3">— {m.mode} · v{m.version}</span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat label="Output Hz" value={String(m.engine?.fps ?? 0)} series={hist.fps} max={60} warn={!m.engine?.up} />
        <Stat label="Packets/s" value={String(m.engine?.pps ?? 0)} series={hist.pps} />
        <Stat label="Render FPS" value={(m.render?.fps ?? 0).toFixed(0)} series={hist.rfps} max={60} />
        <Stat label="CPU %" value={(m.system?.cpuPct ?? 0).toFixed(0)} series={hist.cpu} max={100} warn={(m.system?.cpuPct ?? 0) > 85} />
        <Stat label="Heap MB" value={(m.system?.heapMB ?? 0).toFixed(0)} series={hist.heap} />
        <Stat label="Loop lag p99" value={`${(m.system?.eventLoopLagP99Ms ?? 0).toFixed(1)}ms`} series={hist.lag}
          warn={(m.system?.eventLoopLagP99Ms ?? 0) > 50} />
      </div>

      <div className="text-micro text-fg-3">
        Universes {m.engine?.universes ?? 0} · RSS {(m.system?.rssMB ?? 0).toFixed(0)} MB ·
        frame p99 {(m.render?.frameP99 ?? 0).toFixed(1)}ms · long frames {m.render?.longFrames ?? 0}
      </div>

      {/* The unattended self-heal audit trail — the reason a venue can be left running. */}
      {!!m.watchdog?.length && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 text-mini text-fg-2">
            <ShieldCheck size={12} className="text-ok" /> Watchdog — recent self-heals
          </div>
          {m.watchdog.slice(0, 6).map((w, i) => (
            <div key={i} className="px-2 py-1 rounded border border-line-1 bg-surface-2 text-micro">
              <span className="num text-fg-3">{new Date(w.ts).toLocaleTimeString()}</span>{' '}
              <span className="text-fg-1">{w.trigger} → {w.action}</span>{' '}
              <span className={w.outcome === 'ok' ? 'text-ok' : 'text-warn'}>{w.outcome}</span>
              {w.detail && <div className="text-fg-3 truncate">{w.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
