import React, { useMemo, useRef, useEffect } from 'react';
import { Fixture } from '../types';
import { dmxSignal } from '../services/dmxSignal';

interface DMXMonitorProps {
  fixtures: Fixture[];
}

// Live pixel strip + intensity-shaded value readout, fed off the dmxSignal bus.
const FixtureStrip: React.FC<{ fixture: Fixture; offset: number }> = ({ fixture, offset }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(offset);

  useEffect(() => { offsetRef.current = offset; }, [offset]);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    cvs.width = fixture.ledCount;
    cvs.height = 1;
    const imgData = ctx.createImageData(fixture.ledCount, 1);
    const data = imgData.data;

    const unsubscribe = dmxSignal.subscribe((packet) => {
      const allPixels = packet.pixels;
      const startIdx = offsetRef.current * 4;
      const endIdx = startIdx + fixture.ledCount * 4;
      if (endIdx > allPixels.length) return;

      let ptr = 0;
      let peak = 0;
      for (let i = startIdx; i < endIdx; i += 4) {
        // Canonical pixels are RGBW: the white channel (i+3) holds the neutral
        // component pulled out of RGB by the RGBW-subtract shader. Fold it back in
        // so whites read as white in the preview (W is 0 for RGB/NONE fixtures).
        const w = allPixels[i + 3];
        const r = Math.min(255, allPixels[i] + w);
        const g = Math.min(255, allPixels[i + 1] + w);
        const b = Math.min(255, allPixels[i + 2] + w);
        data[ptr] = r; data[ptr + 1] = g; data[ptr + 2] = b; data[ptr + 3] = 255;
        ptr += 4;
        const m = Math.max(r, g, b);
        if (m > peak) peak = m;
      }
      ctx.putImageData(imgData, 0, 0);
      // Intensity meter: width + value shaded by peak channel.
      if (meterRef.current) {
        const pct = Math.round((peak / 255) * 100);
        meterRef.current.style.width = `${pct}%`;
        meterRef.current.style.opacity = `${0.35 + (peak / 255) * 0.65}`;
      }
    });

    return () => unsubscribe();
  }, [fixture.ledCount]);

  return (
    <div className="space-y-1">
      <canvas
        ref={canvasRef}
        className="w-full h-7 bg-surface-0 rounded-[var(--r-sm)] border border-line-2"
        style={{ imageRendering: 'pixelated' }}
      />
      <div className="h-1 w-full bg-surface-0 rounded-full overflow-hidden">
        <div ref={meterRef} className="h-full bg-accent rounded-full" style={{ width: '0%' }} />
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone = 'text-fg-1' }) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-[10px] uppercase tracking-wider text-fg-3">{label}</span>
    <span className={`num text-sm ${tone}`}>{value}</span>
  </div>
);

export const DMXMonitor: React.FC<DMXMonitorProps> = ({ fixtures }) => {
  const stats = useMemo(() => {
    const channels = fixtures.reduce((acc, f) => acc + f.ledCount * 4, 0);
    const touchedUniverses = new Set<number>();
    fixtures.forEach((f) => {
      const startAbs = f.universe * 512 + (f.startAddress - 1);
      const endAbs = startAbs + f.ledCount * 4 - 1;
      for (let u = Math.floor(startAbs / 512); u <= Math.floor(endAbs / 512); u++) touchedUniverses.add(u);
    });
    return { channels, universes: touchedUniverses.size };
  }, [fixtures]);

  const fixtureOffsets = useMemo(() => {
    const offsets: Record<string, number> = {};
    let current = 0;
    fixtures.forEach((f) => { offsets[f.id] = current; current += f.ledCount; });
    return offsets;
  }, [fixtures]);

  return (
    <div className="h-full flex flex-col bg-surface-0 text-fg-1">
      {/* Compact stat bar */}
      <div className="shrink-0 flex items-center gap-5 px-3 h-9 border-b border-line-1 bg-surface-1">
        <Stat label="Fixtures" value={fixtures.length} />
        <Stat label="Channels" value={stats.channels} />
        <Stat label="Universes" value={stats.universes} />
        <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-fg-3">
          <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" /> Live
        </span>
      </div>

      {/* Fixture grid */}
      {fixtures.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-fg-3 text-xs italic">No fixtures patched.</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 content-start">
          {fixtures.map((fixture) => {
            const startAbs = fixture.universe * 512 + (fixture.startAddress - 1);
            const endAbs = startAbs + fixture.ledCount * 4 - 1;
            const startU = Math.floor(startAbs / 512);
            const endU = Math.floor(endAbs / 512);
            const uDisplay = startU === endU ? `${startU}` : `${startU}-${endU}`;
            return (
              <div key={fixture.id} className="bg-surface-1 border border-line-1 rounded-[var(--r-md)] p-2.5 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <span className="text-xs font-medium text-fg-1 truncate">{fixture.name}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="num text-[10px] text-fg-2 bg-surface-0 px-1.5 py-0.5 rounded-[var(--r-sm)] border border-line-2">U:{uDisplay}.{fixture.startAddress}</span>
                    <span className="num text-[10px] text-fg-2 bg-surface-0 px-1.5 py-0.5 rounded-[var(--r-sm)] border border-line-2">{fixture.ledCount}px</span>
                  </div>
                </div>
                <FixtureStrip fixture={fixture} offset={fixtureOffsets[fixture.id]} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
