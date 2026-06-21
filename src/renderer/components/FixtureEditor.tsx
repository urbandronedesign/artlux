import React from 'react';
import { Fixture, LedShape, ColorOrder, RGBWMode } from '../types';
import { Hash, Grid3x3, Cable, Minus } from 'lucide-react';
import { Field, NumberField, Select, Toggle, Segmented } from './ui';

interface Props {
  fixture: Fixture | null;
  onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
}

const Card: React.FC<{ title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title, icon, children, className = '',
}) => (
  <div className={`bg-surface-1 border border-line-1 rounded-[var(--r-md)] flex flex-col min-w-[200px] ${className}`}>
    <div className="px-3 py-1.5 border-b border-line-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fg-2">
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
    <div className="inline-grid gap-px bg-line-1 p-px rounded-[var(--r-sm)]" style={{ gridTemplateColumns: `repeat(${c}, minmax(0, 1fr))` }}>
      {Array.from({ length: r }).map((_, row) =>
        Array.from({ length: c }).map((_, col) => {
          const physCol = serpentine && row % 2 === 1 ? c - 1 - col : col;
          const idx = row * c + physCol;
          const t = (r * c) <= 1 ? 0 : idx / (r * c - 1);
          return (
            <div
              key={`${row}-${col}`}
              className="w-4 h-4 flex items-center justify-center text-[7px] num text-fg-1"
              style={{ background: `rgba(39,182,196,${0.12 + t * 0.5})` }}
              title={`#${idx}`}
            />
          );
        })
      )}
    </div>
  );
};

export const FixtureEditor: React.FC<Props> = ({ fixture, onUpdateFixture }) => {
  if (!fixture) {
    return <div className="h-full flex items-center justify-center text-fg-3 text-xs italic">Select a fixture to edit its pixel structure.</div>;
  }

  const up = (updates: Partial<Fixture>) => onUpdateFixture(fixture.id, updates);
  const shape = fixture.shape ?? LedShape.LINE;
  const cpp = fixture.channelsPerPixel ?? 4;
  const cols = fixture.matrixWidth ?? 8;
  const rows = fixture.matrixHeight ?? 8;
  const totalChannels = fixture.ledCount * cpp;

  return (
    <div className="h-full overflow-auto p-3 bg-surface-0">
      <div className="flex flex-wrap gap-3 items-start">
        {/* Patch / identity */}
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
              {(cols > 16 || rows > 16) && <div className="text-[9px] text-fg-3">Preview capped at 16×16.</div>}
            </>
          ) : (
            <div className="flex flex-wrap gap-px max-w-[260px]">
              {Array.from({ length: Math.min(fixture.ledCount, 64) }).map((_, i) => {
                const t = fixture.ledCount <= 1 ? 0 : i / (Math.min(fixture.ledCount, 64) - 1);
                const idx = fixture.reverse ? fixture.ledCount - 1 - i : i;
                return <div key={i} className="w-2.5 h-2.5 rounded-[1px]" title={`#${idx}`} style={{ background: `rgba(39,182,196,${0.15 + t * 0.55})` }} />;
              })}
              {fixture.ledCount > 64 && <span className="text-[9px] text-fg-3 self-center ml-1">+{fixture.ledCount - 64}</span>}
            </div>
          )}
          <div className="num text-[10px] text-fg-3 pt-1">{totalChannels} ch · {fixture.ledCount} px × {cpp}</div>
        </Card>
      </div>
    </div>
  );
};
