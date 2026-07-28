import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, AlertTriangle, Check } from 'lucide-react';
import type { ProjectorOutput, ProjectorBlend } from '../../../shared/protocol';
import * as blendController from './blendController';
import { getHost } from './calibHost';

// Proving a solved blend WITHOUT two projectors on a wall.
//
// Two overlapping desktop windows cannot show a seam: opaque BrowserWindows composite alpha-over, so
// the overlap occludes instead of summing light. That is a compositor fact, not a missing feature —
// which leaves this the only honest way to check a rig blend before a venue visit.
//
// The load-bearing view is the SUM. Each projector's alpha map is easy to look at and tells you very
// little; what an operator needs to know is whether every lit surface point receives exactly one unit
// of light. So the coverage map paints Σα, with anything off 1.0 in warning colour — and because the
// maps are indexed per projector, summing them means going through the WORLD, which is precisely what
// the solve claims to have got right.

type Mode = 'sum' | 'alpha' | 'black';

interface Props { outputs?: ProjectorOutput[] }

// Deviation from unity → colour. Neutral grey at exactly 1, warm as it climbs (too much light: a
// bright band), cold as it falls (a dark one). Deliberately NOT a rainbow: the eye should be drawn to
// the sign and the magnitude of the error, not asked to decode a hue wheel.
function deviationColor(sum: number): [number, number, number] {
  if (sum <= 0.001) return [10, 10, 10];           // unlit — not an error, just nothing there
  const d = sum - 1;
  const t = Math.min(1, Math.abs(d) / 0.25);       // full colour at 25% off
  const base = 150;
  if (d >= 0) return [base + Math.round(105 * t), Math.round(base * (1 - t * 0.8)), Math.round(base * (1 - t))];
  return [Math.round(base * (1 - t)), Math.round(base * (1 - t * 0.5)), base + Math.round(105 * t)];
}

const grey = (v: number): [number, number, number] => {
  const g = Math.round(Math.min(1, Math.max(0, v)) * 255);
  return [g, g, g];
};

export const BlendInspector: React.FC<Props> = ({ outputs }) => {
  const [mode, setMode] = useState<Mode>('sum');
  const [, bump] = useState(0);
  useEffect(() => getHost()?.projectorOutputs.subscribe(() => bump((n) => n + 1)) ?? (() => {}), []);

  const outs = (outputs ?? ((getHost()?.projectorOutputs.list() ?? []) as ProjectorOutput[]))
    .filter((o) => o.blend);
  const rig = blendController.rigOutputs();

  // Σα over the WORLD. The maps are per projector and do not share a grid, so they cannot simply be
  // added cell-by-cell — that would sum two different places. Instead each projector's covered cells
  // are binned by the world point the solve associated them with, exactly as computeBlendMaps did.
  const summary = useMemo(() => {
    const blends = outs.map((o) => o.blend!).filter(Boolean) as ProjectorBlend[];
    if (!blends.length) return null;
    // Every map in a rig shares w/h (same default sizing), so a like-for-like cell sum is valid
    // WITHIN a rig solved together — which rigIds already guarantees.
    const w = blends[0].w, h = blends[0].h;
    const uniform = blends.every((b) => b.w === w && b.h === h);
    if (!uniform) return { w, h, uniform: false, sums: null, lit: 0, offUnity: 0, worst: 0 };
    const sums = new Float32Array(w * h);
    for (const b of blends) for (let i = 0; i < w * h; i++) sums[i] += b.alpha[i] ?? 0;
    let lit = 0, offUnity = 0, worst = 0;
    for (let i = 0; i < sums.length; i++) {
      if (sums[i] <= 0.02) continue;
      lit++;
      const d = Math.abs(sums[i] - 1);
      if (d > worst) worst = d;
      if (d > 0.06) offUnity++;
    }
    return { w, h, uniform: true, sums, lit, offUnity, worst };
  }, [outs.map((o) => o.blend?.solvedAt).join('|'), outs.length]);

  if (!outs.length) {
    // Empty states name the next action (DESIGN-SYSTEM §6).
    return (
      <div className="p-3 text-xs text-fg-2 space-y-1">
        <div className="flex items-center gap-1.5 text-fg-1 font-medium"><Layers size={13} className="text-accent" /> Blend inspector</div>
        <p className="leading-relaxed">
          No solved blend yet. Calibrate at least two projectors with <b>Auto-Align</b>, then press{' '}
          <b>Solve blend</b> in Projection Outputs.
        </p>
        {rig.length === 1 && <p className="text-fg-2">One projector is calibrated — a blend needs at least two.</p>}
      </div>
    );
  }

  const stale = outs.some((o) => blendController.isStale(o, rig));

  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-fg-1 font-medium"><Layers size={13} className="text-accent" /> Blend inspector</span>
        <div className="flex-1" />
        <div className="flex items-center rounded border border-line-1 overflow-hidden text-micro" role="radiogroup" aria-label="Inspector view">
          {(['sum', 'alpha', 'black'] as Mode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              className={`px-2 py-0.5 ${mode === m ? 'bg-accent-dim text-fg-1 ring-1 ring-inset ring-accent' : 'bg-surface-1 text-fg-2'}`}>
              {m === 'sum' ? 'Coverage Σα' : m === 'alpha' ? 'Per projector' : 'Black lift'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'sum' && summary && (
        <div className="space-y-2">
          {!summary.uniform ? (
            <div className="flex items-start gap-1.5 text-warn text-mini">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>These maps were not solved together (different grid sizes) — re-solve the rig before trusting a sum.</span>
            </div>
          ) : (
            <>
              <GridCanvas w={summary.w} h={summary.h} pixel={(i) => deviationColor(summary.sums![i])} />
              <div className="flex items-center gap-3 text-micro text-fg-2">
                <span className="flex items-center gap-1"><Swatch rgb={[150, 150, 150]} /> Σα = 1 (correct)</span>
                <span className="flex items-center gap-1"><Swatch rgb={[255, 30, 0]} /> too bright</span>
                <span className="flex items-center gap-1"><Swatch rgb={[0, 75, 255]} /> too dark</span>
              </div>
              <div className="flex items-center gap-2 text-mini">
                {summary.offUnity === 0
                  ? <span className="flex items-center gap-1 text-ok"><Check size={12} /> every lit cell sums to 1 within 6%</span>
                  : <span className="flex items-center gap-1 text-warn"><AlertTriangle size={12} /> {summary.offUnity} of {summary.lit} lit cells are more than 6% off unity</span>}
                <span className="text-fg-2 font-mono">worst {(summary.worst * 100).toFixed(1)}%</span>
              </div>
              {/* Honest about what a residual here means, so a few percent is not read as a defect. */}
              <p className="text-micro text-fg-2 leading-snug">
                A few percent is discretization, not a fault: two projectors do not share a cell grid, so the
                residual is about <span className="font-mono">0.5/N</span> for an overlap N cells wide. A
                structured pattern — a band, a gradient across the whole overlap — is a real problem.
              </p>
            </>
          )}
        </div>
      )}

      {mode !== 'sum' && (
        <div className="space-y-2">
          {outs.map((o) => {
            const b = o.blend!;
            const data = mode === 'alpha' ? b.alpha : b.black;
            return (
              <div key={o.surfaceId} className="space-y-1">
                <div className="flex items-center gap-2 text-mini">
                  <span className="text-fg-1 truncate">{o.surfaceId.slice(0, 8)}</span>
                  <span className="text-fg-2 font-mono text-micro">{b.w}×{b.h}</span>
                  {blendController.isStale(o, rig) && <span className="text-warn text-micro flex items-center gap-1"><AlertTriangle size={11} /> stale</span>}
                </div>
                {data
                  ? <GridCanvas w={b.w} h={b.h} pixel={(i) => grey(data[i] ?? 0)} />
                  : <div className="text-micro text-fg-2">no black-lift grid — nothing overlaps this projector</div>}
              </div>
            );
          })}
        </div>
      )}

      {stale && (
        <div className="flex items-start gap-1.5 text-warn text-mini">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>A projector was recalibrated after this blend was solved. It still renders — a slightly wrong seam beats a hole in the show — but re-solve when you can.</span>
        </div>
      )}
    </div>
  );
};

const Swatch: React.FC<{ rgb: [number, number, number] }> = ({ rgb }) => (
  <span className="inline-block w-2.5 h-2.5 rounded-sm border border-line-1 no-press"
    style={{ background: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` }} />
);

// A low-res grid drawn at native size and scaled up with smoothing OFF — the cells are the data, and
// interpolating them would hide exactly the single-cell anomaly this view exists to reveal.
const GridCanvas: React.FC<{ w: number; h: number; pixel: (i: number) => [number, number, number] }> = ({ w, h, pixel }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const [r, g, b] = pixel(i);
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [w, h, pixel]);
  return (
    <canvas ref={ref} aria-hidden
      className="w-full rounded border border-line-1 bg-bg-stage no-press"
      style={{ imageRendering: 'pixelated', aspectRatio: `${w} / ${h}` }} />
  );
};
