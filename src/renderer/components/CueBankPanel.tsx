import React, { useEffect, useRef, useState } from 'react';
import { Scene, Cue, CueBank, CueEntry, CueTransition, Surface, Fixture } from '../types';
import { Plus, Trash2, Play, RefreshCw, Camera, Zap, X } from 'lucide-react';
import { getByPath, globalParams, surfaceParams, fixtureParams, type StateView, type ParamDef } from '../services/paramPath';

interface Props {
    banks: CueBank[];
    onChangeBanks: (banks: CueBank[]) => void;
    scenes: Scene[];
    surfaces: Surface[];
    fixtures: Fixture[];
    getCurrentState: () => StateView;
    oscPrefix: string;
    // Scene (row 0) operations — Scenes live in App's scenes[]; the grid references them by id.
    onCaptureScene: () => void;
    onRecallScene: (scene: Scene) => void;
    onUpdateScene: (id: string) => void;
    onRemoveScene: (id: string) => void;
    onRenameScene: (id: string, name: string) => void;
    onUpdateSceneFade: (id: string, fadeSec: number) => void;
    // Cue firing
    onFireCue: (cue: Cue) => void;
    onFireColumn: (bankId: string, col: number) => void;
}

const TRANSITIONS: CueTransition[] = ['smooth', 'linear', 'damper', 'none'];
const uid = () => crypto.randomUUID();

// Bottom-dock cue-bank grid (MadMapper-style). Row 0 holds Scenes (whole-look snapshots), rows 1+
// hold granular Cues (parameter subsets). Live mode: click a cell to fire it. Edit mode: click to
// select and author it in the inspector. Column headers fire the whole column.
export const CueBankPanel: React.FC<Props> = ({
    banks, onChangeBanks, scenes, surfaces, fixtures, getCurrentState, oscPrefix,
    onCaptureScene, onRecallScene, onUpdateScene, onRemoveScene, onRenameScene, onUpdateSceneFade, onFireCue, onFireColumn,
}) => {
    const [editSceneId, setEditSceneId] = useState<string | null>(null);
    const [editSceneName, setEditSceneName] = useState('');
    const pendingSceneColRef = useRef<number | null>(null); // column to place the next captured scene at
    const [bankIdx, setBankIdx] = useState(0);
    const [mode, setMode] = useState<'live' | 'edit'>('live');
    const [selCueId, setSelCueId] = useState<string | null>(null);
    const [addOpen, setAddOpen] = useState(false);

    const bank = banks[Math.min(bankIdx, banks.length - 1)];

    // Reconcile row-0 scene cells with scenes[]: append newly-captured scenes, drop deleted ones.
    useEffect(() => {
        if (!bank) return;
        const ids = new Set(scenes.map(s => s.id));
        let cells = bank.sceneCells.filter(c => ids.has(c.sceneId));
        const placed = new Set(cells.map(c => c.sceneId));
        let nextCol = cells.reduce((m, c) => Math.max(m, c.col + 1), 0);
        const occupied = new Set(cells.map(c => c.col));
        for (const s of scenes) if (!placed.has(s.id)) {
            // Honor a column requested via a scene-row "+" (once), else append at the next free column.
            let col = pendingSceneColRef.current;
            if (col == null || occupied.has(col)) col = nextCol++; else pendingSceneColRef.current = null;
            occupied.add(col);
            cells = [...cells, { col, sceneId: s.id }];
        }
        if (cells.length !== bank.sceneCells.length || cells.some((c, i) => c !== bank.sceneCells[i])) {
            patchBank({ sceneCells: cells });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scenes, bankIdx]);

    if (!bank) {
        return (
            <div className="h-full flex items-center justify-center text-fg-3 text-[12px] italic">
                <button onClick={() => onChangeBanks([{ id: uid(), name: 'Bank 1', rows: 8, cols: 16, cues: [], sceneCells: [] }])}
                    className="px-2 py-1 rounded bg-accent/15 text-accent hover:bg-accent/25">Create a cue bank</button>
            </div>
        );
    }

    const patchBank = (patch: Partial<CueBank>) => onChangeBanks(banks.map(b => b.id === bank.id ? { ...b, ...patch } : b));
    const patchCue = (id: string, patch: Partial<Cue>) => patchBank({ cues: bank.cues.map(c => c.id === id ? { ...c, ...patch } : c) });

    // Auto-grow: ensure at least the used columns/rows + 1 spare are visible.
    const usedCols = Math.max(bank.cols, ...bank.cues.map(c => c.col + 2), ...bank.sceneCells.map(c => c.col + 2), 1);
    const usedRows = Math.max(bank.rows, ...bank.cues.map(c => c.row + 2), 1);
    const cols = Array.from({ length: usedCols }, (_, i) => i);
    const rows = Array.from({ length: usedRows - 1 }, (_, i) => i + 1); // cue rows (row 0 = scenes)

    const sceneAt = (col: number): Scene | undefined => {
        const cell = bank.sceneCells.find(c => c.col === col);
        return cell ? scenes.find(s => s.id === cell.sceneId) : undefined;
    };
    const cueAt = (row: number, col: number): Cue | undefined => bank.cues.find(c => c.row === row && c.col === col);

    const addCue = (row: number, col: number) => {
        const cue: Cue = { id: uid(), name: `Cue ${bank.cues.length + 1}`, row, col, entries: [], fadeSec: 1, transition: 'smooth' };
        patchBank({ cues: [...bank.cues, cue] });
        setSelCueId(cue.id);
        setMode('edit');
        setAddOpen(true);
    };
    const removeCue = (id: string) => { patchBank({ cues: bank.cues.filter(c => c.id !== id) }); if (selCueId === id) setSelCueId(null); };

    const selCue = bank.cues.find(c => c.id === selCueId) ?? null;

    // Capture a parameter's current value into the selected cue (add or update its entry).
    const captureEntry = (def: ParamDef) => {
        if (!selCue) return;
        const v = getByPath(getCurrentState(), def.path);
        if (v === undefined) return;
        const entries = selCue.entries.some(e => e.path === def.path)
            ? selCue.entries.map(e => e.path === def.path ? { ...e, value: v as CueEntry['value'] } : e)
            : [...selCue.entries, { path: def.path, value: v as CueEntry['value'] }];
        patchCue(selCue.id, { entries });
    };
    const removeEntry = (path: string) => selCue && patchCue(selCue.id, { entries: selCue.entries.filter(e => e.path !== path) });
    const setEntryValue = (path: string, value: CueEntry['value']) => selCue && patchCue(selCue.id, { entries: selCue.entries.map(e => e.path === path ? { ...e, value } : e) });

    const cellClick = (cue: Cue) => { if (mode === 'live') onFireCue(cue); else { setSelCueId(cue.id); setAddOpen(false); } };

    const cellBase = 'relative h-12 w-24 shrink-0 rounded border text-[10px] px-1.5 py-1 flex flex-col justify-between overflow-hidden transition-colors';

    return (
        <div className="h-full flex flex-col text-fg-2 text-[12px]">
            {/* Toolbar */}
            <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line-1 bg-surface-2">
                <div className="flex items-center gap-1">
                    {banks.map((b, i) => (
                        <button key={b.id} onClick={() => { setBankIdx(i); setSelCueId(null); }}
                            className={`h-6 px-2 rounded text-[11px] ${i === bankIdx ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-surface-3'}`}>{b.name}</button>
                    ))}
                    <button onClick={() => onChangeBanks([...banks, { id: uid(), name: `Bank ${banks.length + 1}`, rows: 8, cols: 16, cues: [], sceneCells: [] }])}
                        className="h-6 w-6 rounded text-fg-3 hover:text-fg-1 hover:bg-surface-3" title="Add bank"><Plus size={13} /></button>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    <button onClick={onCaptureScene} className="inline-flex items-center gap-1 h-6 px-2 rounded bg-surface-3 text-fg-1 hover:bg-surface-3/70 text-[11px]" title="Capture current look as a Scene (row 0)"><Camera size={12} /> Scene</button>
                    <div className="flex items-center rounded bg-surface-0 border border-line-1 overflow-hidden">
                        <button onClick={() => setMode('live')} className={`h-6 px-2 text-[11px] ${mode === 'live' ? 'bg-accent/20 text-accent' : 'text-fg-2'}`}>Live</button>
                        <button onClick={() => setMode('edit')} className={`h-6 px-2 text-[11px] ${mode === 'edit' ? 'bg-accent/20 text-accent' : 'text-fg-2'}`}>Edit</button>
                    </div>
                </div>
            </div>

            <div className="flex-1 min-h-0 flex">
                {/* Grid */}
                <div className="flex-1 min-w-0 overflow-auto p-2">
                    {/* Column headers (fire column) */}
                    <div className="flex gap-1 mb-1 pl-9">
                        {cols.map(c => (
                            <button key={c} onClick={() => onFireColumn(bank.id, c)} title={`Fire column ${c + 1}`}
                                className="h-5 w-24 shrink-0 rounded text-[10px] text-fg-3 bg-surface-2 hover:bg-accent/15 hover:text-accent">▼ {c + 1}</button>
                        ))}
                    </div>
                    {/* Row 0 — Scenes */}
                    <div className="flex gap-1 mb-1 items-center">
                        <div className="w-8 shrink-0 text-[9px] text-fg-3 text-right pr-1">SC</div>
                        {cols.map(c => {
                            const s = sceneAt(c);
                            return s ? (
                                <div key={c} className={`${cellBase} border-sel-surface/40 bg-sel-surface/5 group`}>
                                    <div className="flex items-center gap-1">
                                        <button onClick={() => onRecallScene(s)} className="px-1 rounded bg-accent/15 text-accent hover:bg-accent/25 text-[9px] font-semibold" title="GO">GO</button>
                                        {editSceneId === s.id ? (
                                            <input autoFocus value={editSceneName} onChange={e => setEditSceneName(e.target.value)}
                                                onBlur={() => { if (editSceneName.trim()) onRenameScene(s.id, editSceneName.trim()); setEditSceneId(null); }}
                                                onKeyDown={e => { if (e.key === 'Enter') { if (editSceneName.trim()) onRenameScene(s.id, editSceneName.trim()); setEditSceneId(null); } if (e.key === 'Escape') setEditSceneId(null); }}
                                                className="flex-1 min-w-0 bg-surface-1 border border-line-2 rounded px-1 text-fg-1 text-[10px]" />
                                        ) : (
                                            <span className="truncate flex-1 text-fg-1 cursor-text" title="Double-click to rename" onDoubleClick={() => { setEditSceneId(s.id); setEditSceneName(s.name); }}>{s.name}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center justify-between text-fg-3">
                                        <input type="number" min={0} step={0.1} value={s.fadeSec ?? 0} onChange={e => onUpdateSceneFade(s.id, Math.max(0, Number(e.target.value) || 0))}
                                            title="Crossfade (s)" className="w-9 bg-transparent hover:bg-surface-1 border border-transparent hover:border-line-1 rounded px-0.5 text-fg-3 tabular-nums" />
                                        <span className="opacity-0 group-hover:opacity-100 flex gap-1">
                                            <button onClick={() => onUpdateScene(s.id)} title="Update from current look" className="hover:text-fg-1"><RefreshCw size={10} /></button>
                                            <button onClick={() => onRemoveScene(s.id)} title="Delete scene" className="hover:text-danger"><Trash2 size={10} /></button>
                                        </span>
                                    </div>
                                </div>
                            ) : (
                                <button key={c} onClick={() => { pendingSceneColRef.current = c; onCaptureScene(); }}
                                    title="Capture current look as a Scene here"
                                    className={`${cellBase} border-dashed border-line-1 text-fg-3 hover:border-sel-surface hover:text-sel-surface items-center justify-center`}>
                                    <Camera size={12} />
                                </button>
                            );
                        })}
                    </div>
                    {/* Cue rows */}
                    {rows.map(r => (
                        <div key={r} className="flex gap-1 mb-1 items-center">
                            <div className="w-8 shrink-0 text-[9px] text-fg-3 text-right pr-1">{r}</div>
                            {cols.map(c => {
                                const cue = cueAt(r, c);
                                if (!cue) return (
                                    <button key={c} onClick={() => addCue(r, c)} className={`${cellBase} border-dashed border-line-1 text-fg-3 hover:border-accent hover:text-accent items-center justify-center`}>
                                        <Plus size={12} />
                                    </button>
                                );
                                const sel = cue.id === selCueId;
                                return (
                                    <div key={c} onClick={() => cellClick(cue)} title={mode === 'live' ? 'Fire cue' : 'Edit cue'}
                                        className={`${cellBase} cursor-pointer group ${sel ? 'border-accent bg-accent/10' : 'border-line-2 bg-surface-2 hover:bg-surface-3'}`}
                                        style={cue.color ? { borderColor: cue.color } : undefined}>
                                        <div className="flex items-center gap-1">
                                            <Zap size={9} className="text-accent shrink-0" />
                                            <span className="truncate flex-1 text-fg-1" title={cue.name}>{cue.name}</span>
                                        </div>
                                        <div className="flex items-center justify-between text-fg-3">
                                            <span>{cue.entries.length}p · {cue.fadeSec.toFixed(1)}s</span>
                                            <button onClick={(e) => { e.stopPropagation(); removeCue(cue.id); }} className="opacity-0 group-hover:opacity-100 hover:text-danger" title="Delete cue"><Trash2 size={10} /></button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>

                {/* Cue inspector (edit mode) */}
                {mode === 'edit' && selCue && (
                    <div className="w-64 shrink-0 border-l border-line-1 bg-surface-1 overflow-auto p-2 space-y-2">
                        <div className="flex items-center gap-1">
                            <input value={selCue.name} onChange={e => patchCue(selCue.id, { name: e.target.value })}
                                className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-[11px]" />
                            <button onClick={() => setSelCueId(null)} className="text-fg-3 hover:text-fg-1"><X size={14} /></button>
                        </div>
                        <div className="flex items-center gap-2 text-[10px]">
                            <label className="text-fg-3">Fade</label>
                            <input type="number" min={0} step={0.1} value={selCue.fadeSec} onChange={e => patchCue(selCue.id, { fadeSec: Math.max(0, Number(e.target.value) || 0) })}
                                className="w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 tabular-nums" />
                            <select value={selCue.transition} onChange={e => patchCue(selCue.id, { transition: e.target.value as CueTransition })}
                                className="flex-1 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1">
                                {TRANSITIONS.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <label className="flex items-center gap-1.5 text-[10px] text-fg-2"><input type="checkbox" checked={!!selCue.restartMedia} onChange={e => patchCue(selCue.id, { restartMedia: e.target.checked })} /> Restart media on fire</label>

                        {/* Entries */}
                        <div className="flex items-center justify-between pt-1">
                            <span className="text-[10px] text-fg-3 uppercase tracking-wide">Parameters ({selCue.entries.length})</span>
                            <button onClick={() => setAddOpen(o => !o)} className="text-accent text-[10px] hover:underline inline-flex items-center gap-0.5"><Plus size={11} /> capture</button>
                        </div>
                        <div className="space-y-1">
                            {selCue.entries.map(e => (
                                <div key={e.path} className="flex items-center gap-1 text-[10px]">
                                    <span className="flex-1 min-w-0 truncate text-fg-2" title={e.path}>{labelForPath(e.path)}</span>
                                    <EntryValue value={e.value} onChange={(v) => setEntryValue(e.path, v)} />
                                    <button onClick={() => removeEntry(e.path)} className="text-fg-3 hover:text-danger"><Trash2 size={10} /></button>
                                </div>
                            ))}
                            {selCue.entries.length === 0 && <div className="text-fg-3 italic text-[10px]">No params — use “capture” to add some.</div>}
                        </div>

                        {/* Capture picker */}
                        {addOpen && (
                            <div className="border border-line-1 rounded p-1.5 bg-surface-0 space-y-1.5 max-h-48 overflow-auto">
                                <CaptureGroup title="Global" defs={globalParams()} cue={selCue} onCapture={captureEntry} />
                                {surfaces.map(s => <CaptureGroup key={s.id} title={s.name} defs={surfaceParams(s)} cue={selCue} onCapture={captureEntry} />)}
                                {fixtures.map(f => <CaptureGroup key={f.id} title={f.name} defs={fixtureParams(f)} cue={selCue} onCapture={captureEntry} />)}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Footer hint */}
            <div className="shrink-0 px-3 py-1 border-t border-line-1 bg-surface-2 text-fg-3 text-[10px] truncate">
                {selCue ? <>OSC: <code>{oscPrefix}/cue/{selCue.id}/go</code></> : <>Live: click to fire · Edit: click to author · column ▼ fires the whole column</>}
            </div>
        </div>
    );
};

const CaptureGroup: React.FC<{ title: string; defs: ParamDef[]; cue: Cue; onCapture: (d: ParamDef) => void }> = ({ title, defs, cue, onCapture }) => (
    <div>
        <div className="text-[9px] text-fg-3 uppercase tracking-wide mb-0.5">{title}</div>
        <div className="flex flex-wrap gap-1">
            {defs.map(d => {
                const has = cue.entries.some(e => e.path === d.path);
                return (
                    <button key={d.path} onClick={() => onCapture(d)} title={has ? 'Update value in cue' : 'Add to cue'}
                        className={`px-1.5 py-0.5 rounded text-[9px] border ${has ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line-1 text-fg-2 hover:bg-surface-3'}`}>{d.label}</button>
                );
            })}
        </div>
    </div>
);

const EntryValue: React.FC<{ value: CueEntry['value']; onChange: (v: CueEntry['value']) => void }> = ({ value, onChange }) => {
    if (typeof value === 'number') return <input type="number" step={0.01} value={value} onChange={e => onChange(Number(e.target.value))} className="w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 tabular-nums" />;
    if (typeof value === 'boolean') return <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />;
    return <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value)} className="w-20 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1" />;
};

// Short label from a dot-path leaf (e.g. surfaces.s1.content.opacity -> opacity).
function labelForPath(path: string): string {
    if (path === 'globalBrightness') return 'LED Brightness';
    const parts = path.split('.');
    const leaf = parts.slice(2).join('.').replace(/^content\./, '');
    const owner = parts[0] === 'surfaces' ? 'surf' : 'fix';
    return `${owner} · ${leaf}`;
}
