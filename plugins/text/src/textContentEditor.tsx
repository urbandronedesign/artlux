import React from 'react';
import { Slider, Toggle, Select } from '@/components/ui'; // host UI primitives (pure presentational)
import type { SurfaceContent } from '@/types';
import { DEFAULTS, RENDER_HEIGHTS, DEFAULT_RES } from './textRaster';

// The per-surface inspector fragment for TEXT content, rendered by the host ContentEditor through the
// content-source provider's `editor` hook.
//
// THE COPY BOX IS A REAL <textarea>, and it is the first one in the app — the only other multi-line
// surface is CodeMirror inside the shader editor, which is a code editor and wrong for prose. Enter
// inserts a newline (the raster splits on "\n"); nothing here needs a submit.
//
// COMMIT ON CHANGE, NOT ON BLUR. Type is the one content source where you are judging the RESULT
// letter by letter — the point is to watch it land on the wall while you type — and the cost of doing
// so is one Canvas2D re-raster of a small bitmap, which is what the signature cache is for. Contrast
// the numeric fields, which commit on release like every other slider in the app.

const selCls = 'flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent focus:outline-none';

const Row: React.FC<{ label: string; title?: string; children: React.ReactNode }> = ({ label, title, children }) => (
  <div className="flex items-center justify-between gap-2 text-xs">
    <label className="text-fg-2 w-20 shrink-0 truncate" title={title}>{label}</label>
    {children}
  </div>
);

/** Fill / stroke colour. The app has no colour primitive yet — see the note in the plan. */
const ColorRow: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
  <Row label={label}>
    <div className="flex flex-1 items-center gap-2">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)}
        className="h-5 w-10 shrink-0 cursor-pointer rounded border border-line-1 bg-surface-0" />
      <input type="text" value={value} onChange={(e) => onChange(e.target.value)}
        spellCheck={false} className={`${selCls} num`} />
    </div>
  </Row>
);

export const TextContentEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content: c, onChange }) => (
  <div className="space-y-2 pt-1">
    <textarea
      value={c.textBody ?? DEFAULTS.body}
      onChange={(e) => onChange({ textBody: e.target.value })}
      rows={3}
      spellCheck={false}
      placeholder="Type the copy — Enter starts a new line"
      title="The copy shown on this surface. Enter starts a new line."
      className="w-full resize-y rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-micro text-fg-1 focus:border-accent focus:outline-none"
    />

    <Row label="Font" title="A font family installed on this machine, or one imported into the project">
      <input type="text" value={c.textFont ?? DEFAULTS.font} spellCheck={false}
        onChange={(e) => onChange({ textFont: e.target.value })} className={selCls} />
    </Row>
    <Row label="Weight">
      <Select className="text-micro" value={c.textWeight ?? DEFAULTS.weight}
        onChange={(e) => onChange({ textWeight: parseInt(e.target.value, 10) })}>
        {[100, 200, 300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
      </Select>
    </Row>
    <Toggle label="Italic" checked={c.textItalic ?? false} onChange={(v) => onChange({ textItalic: v || undefined })} />

    {/* Size is a FRACTION OF SURFACE HEIGHT, so type keeps its proportion when the surface is
        resized. Shown as a percentage because that is what the number means. */}
    <Slider label="Size" value={c.textSize ?? DEFAULTS.size} min={0.02} max={1} step={0.005}
      format={(v) => `${(v * 100).toFixed(1)}% of height`} onChange={(v) => onChange({ textSize: v })} />
    <Slider label="Line height" value={c.textLineHeight ?? DEFAULTS.lineHeight} min={0.6} max={3} step={0.05}
      format={(v) => `${v.toFixed(2)}×`} onChange={(v) => onChange({ textLineHeight: v })} />
    <Slider label="Tracking" value={c.textTracking ?? DEFAULTS.tracking} min={-0.2} max={0.6} step={0.005}
      format={(v) => `${(v * 100).toFixed(1)}%`} onChange={(v) => onChange({ textTracking: v })} />
    <Row label="Align">
      <Select className="text-micro" value={c.textAlign ?? DEFAULTS.align}
        onChange={(e) => onChange({ textAlign: e.target.value as 'left' | 'center' | 'right' })}>
        <option value="left">Left</option>
        <option value="center">Center</option>
        <option value="right">Right</option>
      </Select>
    </Row>

    <ColorRow label="Color" value={c.textColor ?? DEFAULTS.color} onChange={(v) => onChange({ textColor: v })} />
    <Slider label="Stroke" value={c.textStrokeWidth ?? DEFAULTS.strokeWidth} min={0} max={0.2} step={0.005}
      format={(v) => (v > 0 ? `${(v * 100).toFixed(1)}%` : 'off')} onChange={(v) => onChange({ textStrokeWidth: v || undefined })} />
    {(c.textStrokeWidth ?? 0) > 0 && (
      <ColorRow label="Stroke color" value={c.textStrokeColor ?? DEFAULTS.strokeColor} onChange={(v) => onChange({ textStrokeColor: v })} />
    )}

    {/* DETAIL is a pixel budget spent in this surface's proportions — the same control, and the same
        reasoning, as the shader plugin's. A projector window ignores it and uses its own raster. */}
    <Row label="Detail" title="Pixel budget for the rasterised type. A projector renders at its own resolution regardless.">
      <Select className="text-micro" value={c.textRes ?? DEFAULT_RES}
        onChange={(e) => onChange({ textRes: parseInt(e.target.value, 10) })}>
        {RENDER_HEIGHTS.map((r) => <option key={r} value={r}>{r}p</option>)}
      </Select>
    </Row>
  </div>
);
