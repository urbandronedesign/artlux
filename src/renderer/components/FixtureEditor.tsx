import React, { useRef } from 'react';
import { Fixture, FixtureTemplate, LedShape } from '../types';
import { Grid3x3, Save, PackagePlus, Trash2, Library, Route, Upload, Download, Eraser, AlertTriangle } from 'lucide-react';
import { Segmented, Button, useToast } from './ui';
import { Tooltip } from './ui/Tooltip';
import { help } from '../services/helpBus';
import { fixtureFootprint } from '../services/addressing';
import { isLight } from '../services/fixtureKind';
import { FixtureProfilePicker } from './FixtureProfilePicker';

// THE FIXTURE BENCH — what is left after the inspector learned about fixture kinds.
//
// This file WAS a seven-card "Fixture Editor" dock: Create, Library, Patch, Pixel Type, Geometry,
// Wiring, Ledmap. Five of those cards were a second rendering of controls that now live in the
// parameter column, kind-gated and invariant-guarded — so a moving head was offered a colour order,
// a serpentine toggle and an LED count, and the same field could be edited in two places with only
// one of them explaining itself.
//
// What was removed, and where it already lives:
//
//   Create      → the Mapping action bar (Add Fixture · Auto-patch)
//   Patch       → core.inspector.fixture.patch      (both kinds; shows the real footprint)
//   Pixel Type  → core.inspector.fixture.output     (colour order, channels/pixel, RGBW mode)
//   Geometry    → core.inspector.fixture.output     (Line/Matrix, cols/rows, serpentine)
//   Reverse     → core.inspector.fixture.mapping
//
// What stayed, because it exists NOWHERE ELSE:
//
//   · the LIBRARY — the shipped DMX profiles and the operator's own LED templates;
//   · the WIRING PREVIEW — MatrixPreview and the physical-index strip. This one nearly went: the
//     plan that proposed the shrink listed only two survivors, and the preview would have been
//     deleted as duplicated when nothing renders it anywhere else;
//   · the LEDMAP tools — load / export / clear / generate-serpentine.
//
// The last two are ONE dock, deliberately: the preview shows the physical pixel order and the ledmap
// remaps it. They are the same question asked twice.
//
// The file keeps its name so its history stays greppable — the same reason RoutingModal.tsx did.

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

// ── THE LIBRARY ─────────────────────────────────────────────────────────────────────────────
// What am I adding? Two tabs rather than two docks: they answer one question, and splitting them
// would make the shipped DMX library easy to miss.

interface LibraryProps {
  /** Only used to decide whether "Save selected" is offered — a template is an LED shape. */
  fixture: Fixture | null;
  templates: FixtureTemplate[];
  onSaveTemplate: () => void;
  onAddFromTemplate: (t: FixtureTemplate) => void;
  onRemoveTemplate: (id: string) => void;
  onAddFromProfile: (profileId: string, modeKey: string) => void;
}

export const FixtureLibrary: React.FC<LibraryProps> = ({
  fixture, templates, onSaveTemplate, onAddFromTemplate, onRemoveTemplate, onAddFromProfile,
}) => {
  const [tab, setTab] = React.useState<'profiles' | 'templates'>('profiles');
  return (
    <div className="h-full overflow-auto p-3 bg-surface-0">
      <Card title="Library" icon={<Library size={12} />} className="min-w-[240px] max-w-[420px]">
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as 'profiles' | 'templates')}
          options={[{ value: 'profiles', label: 'Light Fixtures' }, { value: 'templates', label: 'LED Templates' }]}
        />

        {tab === 'profiles' && (
          <div className="mt-1">
            <FixtureProfilePicker maxHeight="max-h-64" onPick={(id, mode) => onAddFromProfile(id, mode)} />
          </div>
        )}

        {/* A template is an LED-fixture SHAPE (ledCount, matrix, serpentine, colour order), so it
            describes nothing about a moving head and would rebuild one as a 1-LED strip. A light's
            reusable form already exists and is better: its PROFILE plus a mode. */}
        {tab === 'templates' && <>
          <Tooltip id="fixtures.save-template">
            <button
              onClick={onSaveTemplate}
              disabled={!fixture || isLight(fixture)}
              {...help('fixtures.save-template')}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-sm bg-surface-2 border border-line-1 text-fg-2 hover:bg-surface-3 hover:text-fg-1 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
              title={fixture && isLight(fixture)
                ? 'Templates are for LED fixtures — a light is reused through its DMX profile and mode'
                : 'Save the selected LED fixture as a template'}
            >
              <Save size={13} /> Save selected
            </button>
          </Tooltip>
          <div className="space-y-0.5 max-h-64 overflow-y-auto -mx-1 px-1">
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
        </>}
      </Card>
    </div>
  );
};

// ── WIRING & LEDMAP (LED FIXTURES ONLY) ─────────────────────────────────────────────────────
// In what ORDER are this fixture's pixels addressed? The preview answers it and the ledmap changes
// it, which is why they share a dock. Registered `appliesTo: ['fixture.pixel']` — a moving head has
// named channels, not a pixel order.

interface WiringProps {
  fixture: Fixture | null;
  onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
}

export const FixtureWiring: React.FC<WiringProps> = ({ fixture, onUpdateFixture }) => {
  const toast = useToast();
  const ledmapInput = useRef<HTMLInputElement>(null);
  const up = (updates: Partial<Fixture>) => fixture && onUpdateFixture(fixture.id, updates);

  const shape = fixture?.shape ?? LedShape.LINE;
  const cols = fixture?.matrixWidth ?? 8;
  const rows = fixture?.matrixHeight ?? 8;
  const cpp = fixture?.channelsPerPixel ?? 4;
  // Via addressing.ts, so this readout is the number the patch reserves.
  const totalChannels = fixture ? fixtureFootprint(fixture) : 0;
  const ledMapLen = fixture?.ledMap?.length ?? 0;
  const ledMapMismatch = !!fixture?.ledMap && ledMapLen !== fixture.ledCount;

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

  if (!fixture) {
    return <div className="h-full p-3 bg-surface-0 text-mini text-fg-3 italic">Select an LED fixture to see its wiring.</div>;
  }

  return (
    <div className="h-full overflow-auto p-3 bg-surface-0">
      <div className="flex flex-wrap gap-3 items-start">
        <Card title="Wiring" icon={<Route size={12} />}>
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
          {/* Shape, cols/rows, serpentine and reverse are AUTHORED in the inspector; this is the
              picture of what they produced. Saying where they live stops the dock growing them back. */}
          <div className="num text-micro text-fg-3 pt-1">{totalChannels} ch · {fixture.ledCount} px × {cpp}</div>
          <div className="text-micro text-fg-3">Shape, serpentine and reverse are in the inspector.</div>
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
      </div>
    </div>
  );
};
