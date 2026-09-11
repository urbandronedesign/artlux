import React, { useId, useState } from 'react';
import { Slider, Toggle, Select, ColorField } from '@/components/ui'; // host UI primitives (pure presentational)
import type { SurfaceContent } from '@/types';
import { DEFAULTS, RENDER_HEIGHTS, DEFAULT_RES } from './textRaster';
import { families, lastError, refresh, canRender } from './fontList';
import { stateOf } from './fontAssets';
import { useEditor, useEditorActions } from '@/state/EditorStore'; // shell store, as the shader panels use

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

// No `focus:outline-none`: it would kill the global :focus-visible ring on these inputs, and an accent
// border is not a substitute (it shows on mouse focus too). Same rule the kit is guarded on.
const selCls = 'flex-1 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-micro focus:border-accent';

const Row: React.FC<{ label: string; title?: string; children: React.ReactNode }> = ({ label, title, children }) => (
  <div className="flex items-center justify-between gap-2 text-xs">
    <label className="text-fg-2 w-20 shrink-0 truncate" title={title}>{label}</label>
    {children}
  </div>
);

/**
 * The font field: a free-text input backed by a <datalist> of what this machine has.
 *
 * NOT a <select>, deliberately. A show is authored on one machine and run on another, so a project may
 * legitimately name a family this machine does not have — a dropdown would make that unsayable, and
 * would silently rewrite the operator's intent the moment they touched the control. Free text with a
 * type-ahead list keeps both: pick from what is here, or type what will be there.
 */
const FontRow: React.FC<{ content: SurfaceContent; onChange: (p: Partial<SurfaceContent>) => void }> = ({ content: c, onChange }) => {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const { assets } = useEditor();
  const a = useEditorActions();

  // ⚠ ASKED ON THE CLICK THAT OPENS THE LIST, never on mount. queryLocalFonts needs transient user
  // activation as well as the permission, so a mount-time call is rejected — which is exactly how this
  // shipped as an empty dropdown that looked like a machine with no fonts.
  const openList = async () => {
    setOpen((v) => !v);
    if (open) return;
    setBusy(true);
    const f = await families();
    setList(f);
    setErr(f.length ? null : (lastError() ?? 'no fonts came back'));
    setBusy(false);
  };

  const fonts = (assets ?? []).filter((x) => x.type === 'font');
  const asset = c.textFontAsset ?? '';
  const named = c.textFont ?? DEFAULTS.font;
  const missing = !asset && named.trim() !== '' && !canRender(named);
  const shown = filter.trim()
    ? list.filter((f) => f.toLowerCase().includes(filter.trim().toLowerCase()))
    : list;

  return (
    <>
      <Row label="Font" title="A family installed on this machine, or one the show CARRIES (import below)">
        <div className="flex-1">
          {asset ? (
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-micro text-fg-1" title={asset}>
                {fonts.find((f) => f.path === asset)?.name ?? asset.split(/[\/]/).pop()}
              </span>
              <button onClick={() => onChange({ textFontAsset: undefined })}
                className="shrink-0 rounded border border-line-1 px-1.5 py-0.5 text-micro text-fg-2 hover:text-fg-1"
                title="Stop using the imported file and go back to naming a family">Unlink</button>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              {/* Still TYPEABLE: a show authored here may name a family only the venue machine has, and
                  a pure dropdown would make that unsayable. */}
              <input type="text" value={named} spellCheck={false}
                onChange={(e) => onChange({ textFont: e.target.value })} className={`${selCls} min-w-0`} />
              <button onClick={openList} aria-expanded={open}
                className="shrink-0 rounded border border-line-1 px-1.5 py-1 text-micro text-fg-2 hover:text-fg-1"
                title="Pick from the fonts installed on this machine">{open ? '▴' : '▾'}</button>
            </div>
          )}

          {open && !asset && (
            <div className="mt-1 rounded border border-line-1 bg-surface-0">
              <input autoFocus type="text" value={filter} placeholder="Filter…" spellCheck={false}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full border-b border-line-1 bg-transparent px-1.5 py-1 text-micro text-fg-1 focus:border-accent" />
              <div className="max-h-40 overflow-y-auto overscroll-contain">
                {busy && <div className="px-1.5 py-1 text-micro text-fg-3">reading this machine’s fonts…</div>}
                {!busy && err && (
                  <div className="px-1.5 py-1 text-micro text-warn">
                    {err}
                    <button onClick={() => { refresh(); void openList(); }} className="ml-1 underline">retry</button>
                  </div>
                )}
                {!busy && !err && shown.length === 0 && <div className="px-1.5 py-1 text-micro text-fg-3">nothing matches</div>}
                {shown.map((f) => (
                  <button key={f} onClick={() => { onChange({ textFont: f }); setOpen(false); setFilter(''); }}
                    className="pressable block w-full truncate px-1.5 py-1 text-left text-micro text-fg-1"
                    style={{ fontFamily: `"${f}", sans-serif` }}>{f}</button>
                ))}
              </div>
            </div>
          )}

          {/* Say it, rather than letting a substituted face be the only clue. Not an error — the machine
              that RUNS the show is the one that has to have the font, and it may well be another. */}
          {missing && !open && (
            <div className="mt-0.5 text-micro text-warn" title="Chromium is substituting another face here">
              not installed on this machine — drawn in a fallback face
            </div>
          )}
          {asset && stateOf(asset) === 'failed' && (
            <div className="mt-0.5 text-micro text-warn">the font file could not be read — drawn in a fallback face</div>
          )}
        </div>
      </Row>

      {/* THE ONE THAT SURVIVES THE VAN. A named family is whatever the venue machine happens to have;
          an imported file is copied into the project's assets/fonts/, travels with the folder, and is
          picked up by Collect Assets and the missing badge like every other asset. */}
      <Row label="Carry it" title="Copy a font file into the project so the show keeps its typeface anywhere">
        <div className="flex flex-1 items-center gap-2">
          <Select className="text-micro" value={asset}
            onChange={(e) => onChange({ textFontAsset: e.target.value || undefined })}>
            <option value="">Use the named family</option>
            {fonts.map((f) => <option key={f.id} value={f.path}>{f.name}</option>)}
          </Select>
          <button onClick={() => a.importAssets('font')}
            className="shrink-0 rounded border border-line-1 px-1.5 py-0.5 text-micro text-fg-2 hover:text-fg-1"
            title="Import a .ttf / .otf / .woff2 into this project">Import…</button>
        </div>
      </Row>
    </>
  );
};

/**
 * THE TEXT BOX — the rectangle the copy is laid out in, as a share of the surface.
 *
 * Absent means the whole surface, and that stays the default: most text on a mapped surface IS the
 * surface. A box earns its keep the moment one wall carries a title in a corner and a paragraph down
 * one side — then "wrap" has to wrap to something smaller than the wall, and centring has to centre on
 * something other than its middle.
 *
 * Percentages rather than pixels, because a surface has no pixel size of its own: it is a normalized
 * rectangle on the stage, and a box in pixels would mean a different thing on every surface it was
 * copied to.
 */
const TextBoxFields: React.FC<{ content: SurfaceContent; onChange: (p: Partial<SurfaceContent>) => void }> = ({ content: c, onChange }) => {
  const b = c.textBox;
  const set = (patch: Partial<{ x: number; y: number; w: number; h: number }>) =>
    onChange({ textBox: { x: 0, y: 0, w: 1, h: 1, ...b, ...patch } });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="mt-1 border-t border-line-1 pt-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-micro uppercase tracking-wide text-fg-3">Text box</span>
        <button
          onClick={() => onChange({ textBox: b ? undefined : { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })}
          className="rounded border border-line-1 px-1.5 py-0.5 text-micro text-fg-2 hover:text-fg-1"
          title={b ? 'Lay the text out across the whole surface again' : 'Lay the text out inside a rectangle instead of the whole surface'}
        >{b ? 'Use whole surface' : 'Add a box'}</button>
      </div>
      {b && (
        <>
          <Slider label="Left" value={b.x} min={0} max={1} step={0.005} format={pct} onChange={(v) => set({ x: v })} />
          <Slider label="Top" value={b.y} min={0} max={1} step={0.005} format={pct} onChange={(v) => set({ y: v })} />
          <Slider label="Width" value={b.w} min={0.02} max={1} step={0.005} format={pct} onChange={(v) => set({ w: v })} />
          <Slider label="Height" value={b.h} min={0.02} max={1} step={0.005} format={pct} onChange={(v) => set({ h: v })} />
        </>
      )}
    </div>
  );
};

export const TextContentEditor: React.FC<{ content: SurfaceContent; onChange: (patch: Partial<SurfaceContent>) => void }> = ({ content: c, onChange }) => {
  const bodyId = useId();
  return (
    <div className="space-y-2 pt-1">
      {/* LABELLED, and stacked rather than in a Row. An unlabelled full-width box at the top of a panel
          whose every other control IS a labelled row does not read as an input — it reads as a heading
          or a preview of what is set. The first operator to meet this panel asked where to type,
          having already found the Text source and looked straight at this box. A textarea beside a
          20px label column would be unusably narrow, so the label sits above it instead. */}
      <div>
        <label htmlFor={bodyId} className="mb-0.5 block text-xs text-fg-2">Text</label>
        <textarea
          id={bodyId}
          value={c.textBody ?? DEFAULTS.body}
          onChange={(e) => onChange({ textBody: e.target.value })}
          rows={3}
          spellCheck={false}
          placeholder="Type the copy — Enter starts a new line"
          title="The copy shown on this surface. Enter starts a new line."
          className="w-full resize-y rounded border border-line-1 bg-surface-0 px-1.5 py-1 text-micro text-fg-1 focus:border-accent"
        />
      </div>

      <FontRow content={c} onChange={onChange} />
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
          onChange={(e) => onChange({ textAlign: e.target.value as 'left' | 'center' | 'right' | 'justify' })}>
          <option value="left">Left</option>
          <option value="center">Center</option>
          <option value="right">Right</option>
          <option value="justify">Justify</option>
        </Select>
      </Row>
      <Row label="Vertical">
        <Select className="text-micro" value={c.textVAlign ?? 'middle'}
          onChange={(e) => onChange({ textVAlign: e.target.value === 'middle' ? undefined : e.target.value as 'top' | 'bottom' })}>
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom</option>
        </Select>
      </Row>

      {/* Wrapping is what makes a BLOCK of text a block. Off by default — a title's breaks are the
          operator's own, chosen with Enter — and forced on by Justify, which is meaningless without
          it: it would stretch a line you chose the length of out to the full width. */}
      <Toggle
        label={c.textBox ? 'Wrap to the box' : 'Wrap to the surface'}
        checked={c.textWrap === true || c.textAlign === 'justify'}
        title={c.textAlign === 'justify'
          ? 'On, because Justify needs it — without wrapping there is nothing to justify against.'
          : 'Break long lines to fit the measure instead of letting them run off it.'}
        onChange={(v) => onChange({ textWrap: v || undefined })}
      />

      <TextBoxFields content={c} onChange={onChange} />

      <ColorField label="Color" value={c.textColor ?? DEFAULTS.color} onChange={(v) => onChange({ textColor: v })} />
      <Slider label="Stroke" value={c.textStrokeWidth ?? DEFAULTS.strokeWidth} min={0} max={0.2} step={0.005}
        format={(v) => (v > 0 ? `${(v * 100).toFixed(1)}%` : 'off')} onChange={(v) => onChange({ textStrokeWidth: v || undefined })} />
      {(c.textStrokeWidth ?? 0) > 0 && (
        <ColorField label="Stroke color" value={c.textStrokeColor ?? DEFAULTS.strokeColor} onChange={(v) => onChange({ textStrokeColor: v })} />
      )}

      {/* MOTION — the block as a whole, and every one of these is automatable: drop a lane on it in the
          timeline, drive it from OSC, or capture it into a cue. The COPY is not here and cannot be: a
          lane carries a number, so changing the words is a scene/cue swap, not a curve. */}
      <div className="mt-1 border-t border-line-1 pt-2">
        <div className="mb-1 text-micro uppercase tracking-wide text-fg-3">Motion</div>
        <Slider label="Offset X" value={c.textX ?? 0} min={-1} max={1} step={0.005}
          format={(v) => `${(v * 100).toFixed(0)}%`} onChange={(v) => onChange({ textX: v || undefined })} />
        <Slider label="Offset Y" value={c.textY ?? 0} min={-1} max={1} step={0.005}
          format={(v) => `${(v * 100).toFixed(0)}%`} onChange={(v) => onChange({ textY: v || undefined })} />
        {/* Scale multiplies the FONT SIZE, so type stays crisp at any value instead of being a
            resampled bitmap — see textRaster's header. */}
        <Slider label="Scale" value={c.textScale ?? 1} min={0.05} max={4} step={0.01}
          format={(v) => `${v.toFixed(2)}×`} onChange={(v) => onChange({ textScale: v === 1 ? undefined : v })} />
        <Slider label="Rotation" value={c.textRotate ?? 0} min={-180} max={180} step={1}
          format={(v) => `${v.toFixed(0)}°`} onChange={(v) => onChange({ textRotate: v || undefined })} />
      </div>

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
};
