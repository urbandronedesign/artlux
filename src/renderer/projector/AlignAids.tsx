import React from 'react';
import type { SoftEdge } from '../../../shared/protocol';

// ALIGNMENT AIDS — what you project on a real projector while you are still hanging it.
//
// The app could already warp a picture (Align), recover a projector's optics with a camera
// (Calibration), and blend an overlap (soft edge). None of those help with the job that comes FIRST:
// standing in a venue with two machines on a truss, aiming, zooming, rolling and focusing them until
// one's right edge sits exactly on the other's left edge. That is a physical operation, and it needs
// something drawn on the wall to work against.
//
// ⚠ EVERYTHING HERE IS DRAWN IN THE PROJECTOR'S RAW RASTER, UNWARPED — DOM/SVG over the canvas,
// never through the warp pipeline. That is the whole principle, not an implementation shortcut:
// while hanging a projector you are adjusting WHERE ITS LIGHT GOES, so an aid that moved with the
// software warp would hide the very error you are trying to remove. When an output already carries a
// residual warp the overlay says so, because then the picture and the aid genuinely disagree.
//
// See plans/projector-alignment-aids.md for the design and what was deliberately left out.

export type AidPattern = 'grid' | 'blend' | 'focus' | 'grey' | 'bars' | 'checker' | 'white' | 'black';

export interface AlignAidSpec {
  pattern: AidPattern;
  /** This output's identity hue (deg). Two overlapping projectors are told apart by colour alone. */
  hue: number;
  label: string;
  /** The output's REAL soft edge — see the note in App's push about hardware blending. */
  soft: SoftEdge;
  /** How far the content underneath is darkened, 0..1. Not always 1: you often want to align against
   *  the actual show, not a blank field. */
  dim: number;
}

// Distinct, saturated, and — for the first three — the ADDITIVE PRIMARIES, on purpose. Red and green
// projectors read as yellow exactly where they overlap, which is a measurement the eye makes for free
// and the single oldest trick in the trade. Beyond three, hues that stay far apart on a wall.
const AID_HUES = [0, 120, 240, 55, 300, 180, 30, 265];
export const aidHue = (index: number): number => AID_HUES[((index % AID_HUES.length) + AID_HUES.length) % AID_HUES.length];

/**
 * Which colour an output gets — its position among the LIVE outputs, not among all of them.
 *
 * Measured, not assumed: indexing the whole list gave a two-projector wall green and blue, because a
 * third output sat disabled above them. It works, but it quietly breaks the promise the panel and the
 * guide make — that the first machines are red/green/blue and an overlap therefore reads as their mix.
 * Counting only what is actually lit is what makes that promise true on any rig.
 *
 * One exported predicate rather than the same filter written at both call sites (the push and the
 * panel's swatch): if those two ever disagreed, the dot in the list would name the wrong light.
 */
export const isLitOutput = (o: { enabled: boolean; displayId: number | null }): boolean => o.enabled && o.displayId != null;
export const litAidHue = (outputs: Array<{ enabled: boolean; displayId: number | null; surfaceId: string }>, surfaceId: string): number =>
  aidHue(Math.max(0, outputs.filter(isLitOutput).findIndex((o) => o.surfaceId === surfaceId)));

const hsl = (h: number, s: number, l: number, a = 1): string => `hsla(${h}, ${s}%, ${l}%, ${a})`;

interface Props {
  aid: AlignAidSpec;
  size: { w: number; h: number };
  /** The output has a non-identity corner-pin/mesh, so the picture and this aid do not agree. */
  warped: boolean;
  /** Device pixels per CSS pixel — the 1:1 checker is meaningless without it. */
  dpr: number;
}

export const AlignAids: React.FC<Props> = ({ aid, size, warped, dpr }) => {
  const { w, h } = size;
  if (w < 2 || h < 2) return null;
  const C = hsl(aid.hue, 90, 60);
  const CDIM = hsl(aid.hue, 85, 55, 0.35);
  const flat = aid.pattern === 'white' || aid.pattern === 'black';
  // A flat field is the whole point of itself — no chrome on top, or the black patch is not black.
  const scrim = flat ? (aid.pattern === 'white' ? '#ffffff' : '#000000') : `rgba(0,0,0,${aid.dim})`;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', inset: 0, background: scrim }} />

      {/* The 1:1 check is a CSS pattern rather than SVG because it has to land on DEVICE pixels: a
          "1px" CSS square is not one projector pixel on a scaled desktop, and a checker that is
          quietly 1.25 px wide produces the very moiré it exists to detect. */}
      {aid.pattern === 'checker' && (
        <div style={{
          position: 'absolute', inset: 0,
          backgroundImage: 'repeating-conic-gradient(#000 0% 25%, #fff 0% 50%)',
          backgroundSize: `${2 / dpr}px ${2 / dpr}px`,
        }} />
      )}

      {!flat && (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0 }} shapeRendering="crispEdges">
          <defs>
            {/* Hatch for the blend bands — dense enough to read as a texture from the floor, open
                enough that the neighbour's hatch is still visible through the overlap. */}
            <pattern id="aid-hatch" width={12} height={12} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1={0} y1={0} x2={0} y2={12} stroke={CDIM} strokeWidth={3} />
            </pattern>
            <pattern id="aid-fine" width={4} height={4} patternUnits="userSpaceOnUse">
              <rect width={2} height={2} fill="#fff" />
              <rect x={2} y={2} width={2} height={2} fill="#fff" />
              <rect x={2} width={2} height={2} fill="#000" />
              <rect y={2} width={2} height={2} fill="#000" />
            </pattern>
          </defs>

          {aid.pattern === 'grid' && <Grid w={w} h={h} c={C} />}
          {aid.pattern === 'blend' && <Blend w={w} h={h} c={C} soft={aid.soft} />}
          {aid.pattern === 'focus' && <Focus w={w} h={h} c={C} />}
          {aid.pattern === 'grey' && <Greys w={w} h={h} c={C} />}
          {aid.pattern === 'bars' && <Bars w={w} h={h} />}

          <Chrome w={w} h={h} c={C} label={aid.label} />
        </svg>
      )}

      {warped && !flat && (
        // The picture below is being bent by software while this is not. Say it, or the operator
        // chases a physical error that is actually a corner-pin they left in from last time.
        <div style={{
          position: 'absolute', left: '50%', bottom: 18, transform: 'translateX(-50%)',
          padding: '5px 12px', borderRadius: 5, background: 'rgba(0,0,0,0.75)', color: '#ffcf6b',
          font: '600 12px system-ui', letterSpacing: '0.06em', whiteSpace: 'nowrap',
        }}>
          WARPED — this aid shows the raw projector raster, the picture does not
        </div>
      )}
    </div>
  );
};

// ── Common chrome: the raster boundary, corner targets, centre, thirds, the name ────────────────
// The frame is the single most useful line on the wall — it is exactly where this projector's light
// stops, which is what you are aiming.
const Chrome: React.FC<{ w: number; h: number; c: string; label: string }> = ({ w, h, c, label }) => {
  const arm = Math.round(Math.min(w, h) * 0.06);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.round(Math.min(w, h) * 0.05);
  return (
    <g>
      <rect x={1} y={1} width={w - 2} height={h - 2} fill="none" stroke={c} strokeWidth={2} />
      {/* Thirds — a rig is usually judged against room features that fall on them. */}
      {[1 / 3, 2 / 3].map((f) => (
        <g key={f}>
          <line x1={f * w} y1={0} x2={f * w} y2={h} stroke={c} strokeWidth={1} strokeDasharray="6 10" opacity={0.35} />
          <line x1={0} y1={f * h} x2={w} y2={f * h} stroke={c} strokeWidth={1} strokeDasharray="6 10" opacity={0.35} />
        </g>
      ))}
      {/* Numbered corner targets: an L into the corner, so a corner that is off the surface is still
          countable from the floor ("I can only see 3 and 4"). */}
      {([[0, 0, 1, 1], [w, 0, -1, 1], [w, h, -1, -1], [0, h, 1, -1]] as const).map(([x, y, sx, sy], i) => (
        <g key={i}>
          <path d={`M ${x} ${y + sy * arm} L ${x} ${y} L ${x + sx * arm} ${y}`} fill="none" stroke={c} strokeWidth={4} />
          <text x={x + sx * (arm + 14)} y={y + sy * (arm + 6)} fill={c} fontSize={20} fontFamily="system-ui" fontWeight={700}
            textAnchor="middle" dominantBaseline="middle">{i + 1}</text>
        </g>
      ))}
      <g>
        <line x1={cx - arm} y1={cy} x2={cx + arm} y2={cy} stroke={c} strokeWidth={2} />
        <line x1={cx} y1={cy - arm} x2={cx} y2={cy + arm} stroke={c} strokeWidth={2} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={c} strokeWidth={1.5} opacity={0.8} />
      </g>
      <text x={cx} y={Math.max(26, h * 0.055)} fill={c} fontSize={Math.max(16, Math.round(h * 0.035))}
        fontFamily="system-ui" fontWeight={700} letterSpacing={3} textAnchor="middle">{label.toUpperCase()}</text>
    </g>
  );
};

// ── Grid: geometry, keystone, roll — and a shared vocabulary ────────────────────────────────────
// Lettered columns and numbered rows so two people on two ladders can say the same thing about the
// same square: "my P4 has to land on your A4".
const COLS = 16;
const ROWS = 9;
const Grid: React.FC<{ w: number; h: number; c: string }> = ({ w, h, c }) => (
  <g>
    {Array.from({ length: COLS - 1 }, (_, i) => {
      const x = ((i + 1) / COLS) * w;
      return <line key={`v${i}`} x1={x} y1={0} x2={x} y2={h} stroke={c} strokeWidth={(i + 1) % 4 === 0 ? 2 : 1} opacity={(i + 1) % 4 === 0 ? 0.85 : 0.4} />;
    })}
    {Array.from({ length: ROWS - 1 }, (_, i) => {
      const y = ((i + 1) / ROWS) * h;
      return <line key={`hz${i}`} x1={0} y1={y} x2={w} y2={y} stroke={c} strokeWidth={(i + 1) % 3 === 0 ? 2 : 1} opacity={(i + 1) % 3 === 0 ? 0.85 : 0.4} />;
    })}
    {Array.from({ length: COLS }, (_, i) => (
      <text key={`cl${i}`} x={(i + 0.5) * (w / COLS)} y={h - 8} fill={c} fontSize={13} fontFamily="system-ui"
        textAnchor="middle" opacity={0.9}>{String.fromCharCode(65 + i)}</text>
    ))}
    {Array.from({ length: ROWS }, (_, i) => (
      <text key={`rl${i}`} x={10} y={(i + 0.5) * (h / ROWS)} fill={c} fontSize={13} fontFamily="system-ui"
        dominantBaseline="middle" opacity={0.9}>{i + 1}</text>
    ))}
  </g>
);

// ── Blend: THE overlap tool ─────────────────────────────────────────────────────────────────────
// Each feathered side is hatched in this output's hue, its INNER boundary drawn bright, and a ladder
// laid across it. The ladder is what makes this more than a coloured stripe: matching the neighbour's
// rungs proves three different physical adjustments at once —
//   · the bands are the same WIDTH        → the two projectors are at the same zoom / throw
//   · they sit in the same PLACE          → aim
//   · the rungs are parallel              → roll
// which are three separate knobs on the machine, and are otherwise diagnosed by squinting.
const RUNGS = 11;
const Blend: React.FC<{ w: number; h: number; c: string; soft: SoftEdge }> = ({ w, h, c, soft }) => {
  // SoftEdge is a fraction of THIS output's width (left/right) or height (top/bottom) — the same
  // units the shader feathers in, so these rectangles are exactly the ramp, not an approximation.
  const bands: Array<{ side: string; x: number; y: number; bw: number; bh: number; vertical: boolean; inner: number; pct: number }> = [];
  if (soft.left > 0) bands.push({ side: 'LEFT', x: 0, y: 0, bw: soft.left * w, bh: h, vertical: true, inner: soft.left * w, pct: soft.left });
  if (soft.right > 0) bands.push({ side: 'RIGHT', x: w - soft.right * w, y: 0, bw: soft.right * w, bh: h, vertical: true, inner: w - soft.right * w, pct: soft.right });
  if (soft.top > 0) bands.push({ side: 'TOP', x: 0, y: 0, bw: w, bh: soft.top * h, vertical: false, inner: soft.top * h, pct: soft.top });
  if (soft.bottom > 0) bands.push({ side: 'BOTTOM', x: 0, y: h - soft.bottom * h, bw: w, bh: soft.bottom * h, vertical: false, inner: h - soft.bottom * h, pct: soft.bottom });

  if (!bands.length) {
    return (
      <text x={w / 2} y={h * 0.62} fill={c} fontSize={Math.max(13, Math.round(h * 0.026))} fontFamily="system-ui"
        textAnchor="middle" opacity={0.9}>NO SOFT EDGE SET ON THIS OUTPUT — set one in Outputs, or use Grid</text>
    );
  }

  return (
    <g>
      {bands.map((b) => {
        const px = Math.round(b.vertical ? b.bw : b.bh);
        return (
          <g key={b.side}>
            <rect x={b.x} y={b.y} width={b.bw} height={b.bh} fill="url(#aid-hatch)" />
            <rect x={b.x} y={b.y} width={b.bw} height={b.bh} fill="none" stroke={c} strokeWidth={1} opacity={0.6} />
            {/* The inner boundary — where the ramp reaches full brightness. This is the line the
                neighbour's own inner boundary has to meet. */}
            <line
              x1={b.vertical ? b.inner : 0} y1={b.vertical ? 0 : b.inner}
              x2={b.vertical ? b.inner : w} y2={b.vertical ? h : b.inner}
              stroke={c} strokeWidth={3}
            />
            {/* The ladder. Rungs run ACROSS the band at fixed fractions of its length. */}
            {Array.from({ length: RUNGS }, (_, i) => {
              const f = i / (RUNGS - 1);
              const major = i % 5 === 0;
              return b.vertical ? (
                <line key={i} x1={b.x} y1={f * h} x2={b.x + b.bw} y2={f * h} stroke={c} strokeWidth={major ? 2.5 : 1} opacity={major ? 0.95 : 0.55} />
              ) : (
                <line key={i} x1={f * w} y1={b.y} x2={f * w} y2={b.y + b.bh} stroke={c} strokeWidth={major ? 2.5 : 1} opacity={major ? 0.95 : 0.55} />
              );
            })}
            <text
              x={b.vertical ? b.x + b.bw / 2 : w / 2}
              y={b.vertical ? h * 0.5 : b.y + b.bh / 2}
              fill={c} fontSize={Math.max(12, Math.round(Math.min(w, h) * 0.022))} fontFamily="system-ui" fontWeight={700}
              textAnchor="middle" dominantBaseline="middle"
              transform={b.vertical ? `rotate(-90 ${b.x + b.bw / 2} ${h * 0.5})` : undefined}
            >{`${b.side}  ${(b.pct * 100).toFixed(1)}%  ·  ${px}px`}</text>
          </g>
        );
      })}
    </g>
  );
};

// ── Focus: sharpness where a projector focused only in the middle gives itself away ─────────────
const Focus: React.FC<{ w: number; h: number; c: string }> = ({ w, h, c }) => {
  const s = Math.round(Math.min(w, h) * 0.11);
  const spots: Array<[number, number]> = [];
  for (const fy of [0.14, 0.5, 0.86]) for (const fx of [0.12, 0.5, 0.88]) spots.push([fx * w, fy * h]);
  return (
    <g>
      {spots.map(([x, y], i) => (
        <g key={i}>
          <rect x={x - s / 2} y={y - s / 2} width={s} height={s} fill="url(#aid-fine)" />
          <rect x={x - s / 2} y={y - s / 2} width={s} height={s} fill="none" stroke={c} strokeWidth={1.5} />
          {[0.3, 0.6, 0.9].map((f) => (
            <circle key={f} cx={x} cy={y} r={(s / 2) * f} fill="none" stroke={c} strokeWidth={1} opacity={0.75} />
          ))}
        </g>
      ))}
    </g>
  );
};

// ── Grey: brightness + gamma match, and the black patch where a blend's lifted black shows ──────
const STEPS = 11;
const Greys: React.FC<{ w: number; h: number; c: string }> = ({ w, h, c }) => {
  const bw = w / STEPS;
  const y = h * 0.36;
  const bh = h * 0.28;
  return (
    <g>
      {Array.from({ length: STEPS }, (_, i) => {
        const v = i / (STEPS - 1);
        const lum = Math.round(v * 255);
        return (
          <g key={i}>
            <rect x={i * bw} y={y} width={bw} height={bh} fill={`rgb(${lum},${lum},${lum})`} />
            <text x={i * bw + bw / 2} y={y + bh + 20} fill={c} fontSize={13} fontFamily="system-ui" textAnchor="middle">
              {Math.round(v * 100)}
            </text>
          </g>
        );
      })}
      <rect x={0} y={y} width={w} height={bh} fill="none" stroke={c} strokeWidth={1.5} />
    </g>
  );
};

// ── Bars: colour match between machines ─────────────────────────────────────────────────────────
const BAR_COLORS = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff'];
const Bars: React.FC<{ w: number; h: number }> = ({ w, h }) => {
  const bw = w / BAR_COLORS.length;
  return (
    <g>
      {BAR_COLORS.map((col, i) => <rect key={col} x={i * bw} y={h * 0.22} width={bw} height={h * 0.56} fill={col} />)}
    </g>
  );
};
