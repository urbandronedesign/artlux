import React, { useRef } from 'react';
import { Fixture, FixtureTemplate, LedShape, ColorOrder, RGBWMode } from '../types';
import { Hash, Grid3x3, Cable, Minus, Plus, Save, PackagePlus, Trash2, Library, Route, Upload, Download, Eraser, AlertTriangle } from 'lucide-react';
import { Field, NumberField, Select, Toggle, Segmented, Button, useToast } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';

interface Props {
  fixture: Fixture | null;
  onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
  onAdd: () => void;
  onAutoPatch: () => void;
  templates: FixtureTemplate[];
  onSaveTemplate: () => void;
  onAddFromTemplate: (t: FixtureTemplate) => void;
  onRemoveTemplate: (id: string) => void;
}

const Card: React.FC<{ title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title, icon, children, className = '',
}) => (
  <div className={`bg-surface-1 border border-line-1 rounded-md flex flex-col min-w-[200px] ${className}`}>
    <div className="px-3 py-1.5 border-b border-line-1 flex items-center gap-2 text-mini font-semibold uppercase tracking-wider text-fg-2">
      {icon && <span className="text-fg-3">{icon}</span>}
      {title}
    </div>
    <div className="p-3 space-y-2.5">{children}</div>
  </div>
);

// Visual wiring preview: physical index per cell, honoring serpentine "assignation".
const MatrixPreview: React.FC<{ cols: number; rows: number; serpentine: boolean }> = ({ cols, rows, serpentine }) => {
  const cap = 16;
  const c = Math.min(cols, cap);
  const r = Math.min(rows, cap);
  return (
    <div className="inline-grid gap-px bg-line-1 p-px rounded-sm" style={{ gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))` }}>
      {Array.from({ length: r }).map((_, row) =>
        Array.from({ length: c }).map((_, col) => {
          const physCol = serpentine && row % 2 === 1 ? c - 1 - col : col;
          const idx = row * c + physCol;
          const t = (r * c) <= 1 ? 0 : idx / (r * c - 1);
          return (
            <div
              key={`${row}-${col}`}
              className="w-4 h-4 flex items-center justify-center text-micro num text-fg-1"
              style={{ background: `rgba(39,182,196,${0.12 + t * 0.5})` }}
              title={`#${idx}`}
            />
          );
        })
      )}
    </div>
  );
};

export const FixtureEditor: React.FC<Props> = ({
  fixture,
  onUpdateFixture,
  onAdd,
  onAutoPatch,
  templates,
  onSaveTemplate,
  onAddFromTemplate,
  onRemoveTemplate,
}) => {
  const toast = useToast();
  const up = (updates: Partial<Fixture>) => fixture && onUpdateFixture(fixture.id, updates);
  const shape = fixture?.shape ?? LedShape.LINE;
  const cpp = fixture?.channelsPerPixel ?? 4;
  const cols = fixture?.matrixWidth ?? 8;
  const rows = fixture?.matrixHeight ?? 8;
  const totalChannels = (fixture?.ledCount ?? 0) * cpp;

  // Ledmap — WLED-style physical→geometry remap. See docs/LEDMAP.md.
  const ledmapInput = useRef<HTMLInputElement>(null);

  const handleLedmapUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-loading the same file
    if (!file || !fixture) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const map: number[] = Array.isArray(parsed) ? parsed : parsed.map;
        if (Array.isArray(map) && map.every((n) => typeof n === 'number')) up({ ledMap: map });
        else toast.error('Unrecognized ledmap format', 'Expected a JSON array of numbers, or {"map":[…]}. Re-export from the source, or check the file.');
      } catch {
        toast.error('Failed to parse ledmap JSON', 'The file isn’t valid JSON. Open it in a text editor to check for a stray comma or truncation.');
      }
    };
    reader.readAsText(file);
  };

  const exportLedmap = () => {
    if (!fixture) return;
    // Export the current map, or an identity template sized to the fixture as a starting point.
    const map = fixture.ledMap ?? Array.from({ length: fixture.ledCount }, (_, i) => i);
    const blob = new Blob([JSON.stringify({ map }, null, 0)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(fixture.name || 'fixture').replace(/[^\w.-]+/g, '_')}-ledmap.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Bake serpentine wiring into a ledmap, then disable the serpentine toggle so the
  // engine doesn't apply the flip twice (transform order is reverse → ledmap → serpentine).
  const generateSerpentine = () => {
    if (!fixture) return;
    const map: number[] = [];
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const col = y % 2 === 0 ? x : cols - 1 - x;
        map.push(y * cols + col);
      }
    up({ ledMap: map, serpentine: false });
  };

  const ledMapLen = fixture?.ledMap?.length ?? 0;
  const ledMapMismatch = !!fixture?.ledMap && ledMapLen !== fixture.ledCount;

  return (
    <div className="h-full overflow-auto p-3 bg-surface-0">
      <div className="flex flex-wrap gap-3 items-start">
        {/* Create — fixture creation lives next to the editor */}
        <Card title="Create" icon={<Plus size={12} />} className="min-w-[160px]">
          <Tooltip id="fixtures.add">
            <button
              onClick={onAdd}
              {...help('fixtures.add')}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm bg-surface-2 border border-line-1 text-fg-1 hover:bg-surface-3 text-xs"
            >
              <Plus size={13} /> Add fixture
            </button>
          </Tooltip>
          <Tooltip id="fixtures.auto-patch">
            <button
              onClick={onAutoPatch}
              {...help('fixtures.auto-patch')}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm bg-surface-2 border border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 text-xs"
              title="Assign universes/addresses to all fixtures"
            >
              <Hash size={13} /> Auto-patch
            </button>
          </Tooltip>
        </Card>

        {/* Library — fixture templates */}
        <Card title="Library" icon={<Library size={12} />} className="min-w-[200px]">
          <Tooltip id="fixtures.save-template">
            <button
              onClick={onSaveTemplate}
              disabled={!fixture}
              {...help('fixtures.save-template')}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm bg-surface-2 border border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              title="Save the selected fixture as a template"
            >
              <Save size={13} /> Save selected
            </button>
          </Tooltip>
          <div className="space-y-0.5 max-h-40 overflow-y-auto -mx-1 px-1">
            {templates.map(t => (
              <div key={t.id} className="flex items-center group px-2 py-1 rounded hover:bg-surface-3 text-fg-2 text-xs">
                <Tooltip id="fixtures.add-from-template">
                  <button className="flex-1 flex items-center text-left truncate" onClick={() => onAddFromTemplate(t)} {...help('fixtures.add-from-template')} title="Add a fixture from this template">
                    <PackagePlus size={12} className="mr-2 text-fg-3" />
                    {t.name} <span className="text-fg-3 ml-1">({t.ledCount})</span>
                  </button>
                </Tooltip>
                <Tooltip id="fixtures.delete-template">
                  <button className="opacity-0 group-hover:opacity-100 hover:text-danger text-fg-3" onClick={() => onRemoveTemplate(t.id)} {...help('fixtures.delete-template')} title="Delete template"><Trash2 size={10} /></button>
                </Tooltip>
              </div>
            ))}
            {templates.length === 0 && <div className="text-fg-3 italic px-2 py-1 text-xs">No templates</div>}
          </div>
        </Card>

        {!fixture && (
          <div className="flex items-center text-fg-3 text-xs italic px-2 py-6 min-w-[200px]">
            Select a fixture to edit its pixel structure.
          </div>
        )}

        {/* Patch / identity */}
        {fixture && <>
        <Card title="Patch" icon={<Hash size={12} />}>
          <NumberField label="LEDs" value={fixture.ledCount} min={1} step={1} onChange={(v) => up({ ledCount: Math.max(1, Math.round(v)) })} />
          <NumberField label="Universe" value={fixture.universe} min={0} step={1} onChange={(v) => up({ universe: Math.max(0, Math.round(v)) })} />
          <NumberField label="Start" value={fixture.startAddress} min={1} max={512} step={1} onChange={(v) => up({ startAddress: Math.max(1, Math.round(v)) })} />
          <Toggle label="Reverse" checked={fixture.reverse} onChange={(v) => up({ reverse: v })} />
        </Card>

        {/* Pixel type = color order + channels */}
        <Card title="Pixel Type" icon={<Cable size={12} />}>
          <Field label="Order">
            <Select value={fixture.colorOrder ?? ColorOrder.RGB} onChange={(e) => up({ colorOrder: e.target.value as ColorOrder })}>
              {Object.values(ColorOrder).map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
          <Field label="Channels">
            <Segmented<number>
              value={cpp}
              onChange={(v) => up({ channelsPerPixel: v as 3 | 4 })}
              options={[{ value: 3, label: 'RGB' }, { value: 4, label: 'RGBW' }]}
            />
          </Field>
          {cpp === 4 && (
            <Field label="White">
              <Select value={fixture.rgbwMode ?? RGBWMode.SUBTRACT} onChange={(e) => up({ rgbwMode: e.target.value as RGBWMode })}>
                <option value={RGBWMode.SUBTRACT}>Subtract min</option>
                <option value={RGBWMode.NONE}>None</option>
              </Select>
            </Field>
          )}
        </Card>

        {/* Geometry = shape + matrix + serpentine assignation */}
        <Card title="Geometry" icon={<Grid3x3 size={12} />}>
          <Field label="Shape">
            <Segmented<string>
              value={shape}
              onChange={(v) => up({ shape: v as LedShape })}
              options={[
                { value: LedShape.LINE, label: 'Line', icon: <Minus size={12} /> },
                { value: LedShape.MATRIX, label: 'Matrix', icon: <Grid3x3 size={12} /> },
              ]}
            />
          </Field>
          {shape === LedShape.MATRIX && (
            <>
              <NumberField label="Cols" value={cols} min={1} step={1} onChange={(v) => up({ matrixWidth: Math.max(1, Math.round(v)) })} />
              <NumberField label="Rows" value={rows} min={1} step={1} onChange={(v) => up({ matrixHeight: Math.max(1, Math.round(v)) })} />
              <Toggle label="Serpentine" checked={fixture.serpentine ?? false} onChange={(v) => up({ serpentine: v })} title="Alternate row wiring direction" />
            </>
          )}
        </Card>

        {/* Wiring preview */}
        <Card title="Wiring" icon={<Cable size={12} />}>
          {shape === LedShape.MATRIX ? (
            <>
              <MatrixPreview cols={cols} rows={rows} serpentine={fixture.serpentine ?? false} />
              {(cols > 16 || rows > 16) && <div className="text-micro text-fg-3">Preview capped at 16×16.</div>}
            </>
          ) : (
            <div className="flex flex-wrap gap-px max-w-[260px]">
              {Array.from({ length: Math.min(fixture.ledCount, 64) }).map((_, i) => {
                const t = fixture.ledCount <= 1 ? 0 : i / (Math.min(fixture.ledCount, 64) - 1);
                const idx = fixture.reverse ? fixture.ledCount - 1 - i : i;
                return <div key={i} className="w-2.5 h-2.5 rounded-[1px]" title={`#${idx}`} style={{ background: `rgba(39,182,196,${0.15 + t * 0.55})` }} />;
              })}
              {fixture.ledCount > 64 && <span className="text-micro text-fg-3 self-center ml-1">+{fixture.ledCount - 64}</span>}
            </div>
          )}
          <div className="num text-micro text-fg-3 pt-1">{totalChannels} ch · {fixture.ledCount} px × {cpp}</div>
        </Card>

        {/* Ledmap = WLED-style physical→geometry pixel remap */}
        <Card title="Ledmap" icon={<Route size={12} />} className="min-w-[200px]">
          <input ref={ledmapInput} type="file" accept=".json,application/json" className="hidden" onChange={handleLedmapUpload} />
          <div className="text-micro text-fg-3 leading-snug">
            Remaps physical pixel order → geometry. Only needed for irregular wiring that Reverse / Serpentine can't express.
          </div>
          <div className="num text-micro pt-0.5">
            {fixture.ledMap
              ? <span className={ledMapMismatch ? 'text-warn' : 'text-fg-2'}>Loaded: {ledMapLen} pts</span>
              : <span className="text-fg-3">No ledmap (identity order)</span>}
          </div>
          {ledMapMismatch && (
            <div className="flex items-start gap-1 text-micro text-warn">
              <AlertTriangle size={11} className="shrink-0 mt-px" />
              <span>Length ({ledMapLen}) ≠ LED count ({fixture.ledCount}); unmapped pixels fall back to identity.</span>
            </div>
          )}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <Button size="sm" onClick={() => ledmapInput.current?.click()} {...help('fixtures.ledmap-load')} title="Load a ledmap.json (array or {map:[...]})">
              <Upload size={12} /> Load
            </Button>
            <Button size="sm" variant="ghost" onClick={exportLedmap} {...help('fixtures.ledmap-export')} title={fixture.ledMap ? 'Export the current ledmap' : 'Export an identity template to edit'}>
              <Download size={12} /> Export
            </Button>
            {fixture.ledMap && (
              <Button size="sm" variant="danger" onClick={() => up({ ledMap: undefined })} {...help('fixtures.ledmap-clear')} title="Remove the ledmap (back to identity order)">
                <Eraser size={12} /> Clear
              </Button>
            )}
          </div>
          {shape === LedShape.MATRIX && (
            <Button size="sm" variant="ghost" className="w-full" onClick={generateSerpentine}
              {...help('fixtures.generate-serpentine')}
              title="Build a serpentine map from cols/rows and disable the Serpentine toggle (avoids double-flip)">
              <Grid3x3 size={12} /> Generate serpentine ({cols}×{rows})
            </Button>
          )}
        </Card>
        </>}
      </div>
    </div>
  );
};
