import React, { useEffect, useRef, useState } from 'react';
import { Scene, Cue, CueBank, CueEntry, CueTransition, Surface, Fixture, sceneAudioEntries, cueEntries } from '../types';
import { Plus, Trash2, RefreshCw, Camera, Zap, X, Film, Music } from 'lucide-react';
import { getByPath, globalParams, surfaceParams, fixtureParams, isFadeablePath, pathLeaf, type StateView, type ParamDef } from '../services/paramPath';
import { automationTargetRegistry } from '../host/registries';
import type { AutomationTargetDef } from '@artlux/sdk/renderer';

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
    // A scene's bound AUDIO params (Scene.audio — an explicit {path,value} list, not a mix snapshot).
    // Optional: without it the ♪ button is not offered and a scene's audio is simply unauthorable here.
    onUpdateSceneAudio?: (id: string, entries: CueEntry[]) => void;
    // Cue firing
    onFireCue: (cue: Cue) => void;
    onFireColumn: (bankId: string, col: number) => void;
    // Per-state timelines: enter author mode on a scene's own timeline; warm its media on hover; which
    // scene is currently being authored (accent dot). All optional (feature-gated in App).
    onEditScene?: (sceneId: string) => void;
    onPreloadScene?: (scene: Scene) => void;
    activeSceneId?: string | null;
}

const TRANSITIONS: CueTransition[] = ['smooth', 'linear', 'damper', 'none'];
const uid = () => crypto.randomUUID();

// Bottom-dock cue-bank grid (MadMapper-style). Row 0 holds Scenes (whole-look snapshots), rows 1+
// hold granular Cues (parameter subsets). Live mode: click a cell to fire it. Edit mode: click to
// select and author it in the inspector. Column headers fire the whole column.
// WHAT THE CAPTURE PICKER IS EDITING. A Cue and a Scene both carry a CueEntry[]; they differ only in where
// that list is COMMITTED. Everything below drives off this, so there is exactly one capture UI and no
// second, drifting copy of the five entry mutators.
// (No `key`/`label` here: the header renders the Scene/Cue directly, so a copy of its name on the target
// would be a second source of truth for the same string, free to drift. WHERE the list is committed is the
// only thing that differs between the two — that is all this carries.)
interface CaptureTarget {
    entries: CueEntry[];
    setEntries: (e: CueEntry[]) => void;
    audioOnly: boolean;   // a Scene binds AUDIO params only — its LOOK is a snapshot, captured elsewhere
}

export const CueBankPanel: React.FC<Props> = ({
    banks, onChangeBanks, scenes, surfaces, fixtures, getCurrentState, oscPrefix,
    onCaptureScene, onRecallScene, onUpdateScene, onRemoveScene, onRenameScene, onUpdateSceneFade, onUpdateSceneAudio,
    onFireCue, onFireColumn, onEditScene, onPreloadScene, activeSceneId,
}) => {
    const [editSceneId, setEditSceneId] = useState<string | null>(null);
    const [editSceneName, setEditSceneName] = useState('');
    const pendingSceneColRef = useRef<number | null>(null); // column to place the next captured scene at
    const [bankIdx, setBankIdx] = useState(0);
    const [mode, setMode] = useState<'live' | 'edit'>('live');
    const [selCueId, setSelCueId] = useState<string | null>(null);
    const [audioSceneId, setAudioSceneId] = useState<string | null>(null); // the scene whose ♪ list is open
    const [addOpen, setAddOpen] = useState(false);

    // PLUGIN NAMESPACES (today: audio), straight off the registry — exactly as the automation target picker
    // already does it. Core does not know what a filter cutoff is and does not need to.
    //
    // FADEABLE LEAVES ONLY. enumerate() is the CATALOG (it emits a def's `params` and nothing else — never a
    // discrete `opts` mode, never mute/solo, never the spatial flag) and isFadeablePath is the GATE. A path
    // that got past both is one the fade engine can hand a number to; anything else would end up
    // interpolating a filter's mode to 0.37.
    //
    // THE RANGES RIDE ALONG. enumerate() carries a min/max for every target and the picker used to throw
    // both away, leaving the entry's value box a free-text <input type=number> with no bound — the one
    // unbounded door into the audio engine's gain (every mixer fader is bounded; master is 0…1.5). Keep the
    // range, bound the input, and clamp on commit.
    //
    // ⚠ DERIVED PER RENDER, NOT MEMOIZED. There is no honest dep for it: the catalog is owned by the audio
    // plugin's live mix, which this panel neither holds nor is told about. It was memoized on `addOpen` (the
    // capture picker's open flag) and that map went STALE the moment the mix changed without the picker
    // toggling — load a project after the panel has mounted, click a cue, and its audio entries render with
    // NO min/max: the bound the box advertises, and the UI clamp behind it, quietly gone. (The engine-door
    // clamp in applyAudioEntries still catches the value, so this was never a level event — but a limit you
    // can see and a limit that is enforced must not disagree.) enumerate() is a plain walk over the mix —
    // the provider's own get() calls it once PER PATH LOOKUP — so re-deriving it is cheaper than a dep that
    // lies. A provider in a bad state must still not take the panel down with it: hence the try/catch.
    const { pluginParamGroups, pluginRanges } = (() => {
        const out: { title: string; defs: ParamDef[] }[] = [];
        const ranges = new Map<string, { min: number; max: number; step?: number }>();
        for (const p of automationTargetRegistry.all()) {
            if (p.namespaces.every(ns => ns === 'surfaces' || ns === 'fixtures' || ns === 'globalBrightness')) continue; // core — already above
            let defs: AutomationTargetDef[] = [];
            try { defs = p.enumerate(); } catch { defs = []; }
            const byGroup = new Map<string, ParamDef[]>();
            for (const d of defs) {
                if (!isFadeablePath(d.path)) continue;
                const g = byGroup.get(d.group) ?? [];
                g.push({ path: d.path, label: d.label });
                byGroup.set(d.group, g);
                ranges.set(d.path, { min: d.min, max: d.max, step: d.step });
            }
            for (const [title, ds] of byGroup) out.push({ title, defs: ds });
        }
        return { pluginParamGroups: out, pluginRanges: ranges };
    })();

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
            <div className="h-full flex items-center justify-center text-fg-3 text-xs italic">
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
        setAudioSceneId(null);
        setSelCueId(cue.id);
        setMode('edit');
        setAddOpen(true);
    };
    const removeCue = (id: string) => { patchBank({ cues: bank.cues.filter(c => c.id !== id) }); if (selCueId === id) setSelCueId(null); };

    const selCue = bank.cues.find(c => c.id === selCueId) ?? null;
    const audioScene = audioSceneId ? scenes.find(s => s.id === audioSceneId) ?? null : null;
    // Which list the picker commits into: a scene's ♪ audio bindings, else the selected cue's entries.
    const target: CaptureTarget | null =
        audioScene && onUpdateSceneAudio
            ? {
                entries: sceneAudioEntries(audioScene),
                setEntries: (e) => onUpdateSceneAudio(audioScene.id, e), audioOnly: true,
            }
            : selCue
                ? {
                    // cueEntries(), not the raw list: `Cue.entries` has no normalizer either, and the rows
                    // below dereference `e.path` in RENDER (labelForPath / isFadeablePath) exactly as the GO
                    // does. `[null]` in a hand-edited bank is a white screen the moment the operator selects
                    // the cue. Same bargain as a scene's ♪ list: an entry with no path can never fire, so it
                    // is dropped from the list rather than repaired.
                    entries: cueEntries(selCue.entries),
                    setEntries: (e) => patchCue(selCue.id, { entries: e }), audioOnly: false,
                }
                : null;

    // Capture a parameter's current value into the open target (add or update its entry).
    const captureEntry = (def: ParamDef) => {
        if (!target) return;
        // Core params live on the StateView (getByPath). A PLUGIN-NAMESPACED param (audio.*) does NOT, and
        // never will — it lives behind the AutomationTargetProvider contract, whose get() returns the
        // AUTHORED value (what the slider last wrote). Without this fallback getByPath returns undefined and
        // the bail below fires: you could not add an audio param to a cue at all.
        const head = def.path.split('.')[0];
        const v = head === 'surfaces' || head === 'fixtures' || def.path === 'globalBrightness'
            ? getByPath(getCurrentState(), def.path)
            : automationTargetRegistry.get(head)?.get(def.path);
        if (v === undefined) return;
        const entries = target.entries.some(e => e.path === def.path)
            ? target.entries.map(e => e.path === def.path ? { ...e, value: v as CueEntry['value'] } : e)
            : [...target.entries, { path: def.path, value: v as CueEntry['value'] }];
        target.setEntries(entries);
    };
    const removeEntry = (path: string) => target?.setEntries(target.entries.filter(e => e.path !== path));
    // CLAMPED ON COMMIT, against the target's own declared range. The value box is free text: `2` typed
    // where `0.2` was meant on audio.master.gain is a +6 dB level event in an unattended venue, and nothing
    // downstream of here would have caught it (the fade engine takes any number; native only jlimits at
    // 4.0). A path with no known range — a core param, or a dangling audio path whose clip is gone — is left
    // alone: we do not invent a bound we do not know. (applyAudioEntries clamps again at the engine door,
    // which is what covers an entry that never passed through this box at all: OSC, or a hand-edited file.)
    const setEntryValue = (path: string, value: CueEntry['value']) => {
        const r = typeof value === 'number' ? pluginRanges.get(path) : undefined;
        const v = r ? Math.min(r.max, Math.max(r.min, value as number)) : value;
        target?.setEntries(target.entries.map(e => e.path === path ? { ...e, value: v } : e));
    };
    // Per-entry Fade/Transition overrides. undefined removes the key (= inherit the cue's/scene's value);
    // note a fadeSec of 0 is a real override (snap), which must stay distinct from "inherit".
    const setEntryFade = (path: string, fadeSec: number | undefined) => target?.setEntries(target.entries.map(e => {
        if (e.path !== path) return e;
        const next: CueEntry = { ...e };
        if (fadeSec === undefined) delete next.fadeSec; else next.fadeSec = fadeSec;
        return next;
    }));
    const setEntryTransition = (path: string, transition: CueTransition | undefined) => target?.setEntries(target.entries.map(e => {
        if (e.path !== path) return e;
        const next: CueEntry = { ...e };
        if (transition === undefined) delete next.transition; else next.transition = transition;
        return next;
    }));

    // Selecting a cue closes the scene's ♪ list (they share one inspector; a scene target OUTRANKS a cue,
    // so leaving audioSceneId set would strand the cue behind it — the way back out).
    const selectCue = (id: string | null) => { setAudioSceneId(null); setSelCueId(id); };
    const cellClick = (cue: Cue) => { if (mode === 'live') onFireCue(cue); else { selectCue(cue.id); setAddOpen(false); } };

    const cellBase = 'relative h-12 w-24 shrink-0 rounded border text-micro px-1.5 py-1 flex flex-col justify-between overflow-hidden transition-colors';

    return (
        <div className="h-full flex flex-col text-fg-2 text-xs">
            {/* Toolbar */}
            <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line-1 bg-surface-2">
                <div className="flex items-center gap-1">
                    {banks.map((b, i) => (
                        <button key={b.id} onClick={() => { setBankIdx(i); setSelCueId(null); setAudioSceneId(null); }}
                            className={`h-6 px-2 rounded text-mini ${i === bankIdx ? 'bg-accent/15 text-accent' : 'text-fg-2 hover:bg-surface-3'}`}>{b.name}</button>
                    ))}
                    <button onClick={() => onChangeBanks([...banks, { id: uid(), name: `Bank ${banks.length + 1}`, rows: 8, cols: 16, cues: [], sceneCells: [] }])}
                        className="h-6 w-6 rounded text-fg-3 hover:text-fg-1 hover:bg-surface-3" title="Add bank"><Plus size={13} /></button>
                </div>
                <div className="ml-auto flex items-center gap-2">
                    <button onClick={onCaptureScene} className="inline-flex items-center gap-1 h-6 px-2 rounded bg-surface-3 text-fg-1 hover:bg-surface-3/70 text-mini" title="Capture current look as a Scene (row 0)"><Camera size={12} /> Scene</button>
                    <div className="flex items-center rounded bg-surface-0 border border-line-1 overflow-hidden">
                        <button onClick={() => setMode('live')} className={`h-6 px-2 text-mini ${mode === 'live' ? 'bg-accent/20 text-accent' : 'text-fg-2'}`}>Live</button>
                        <button onClick={() => setMode('edit')} className={`h-6 px-2 text-mini ${mode === 'edit' ? 'bg-accent/20 text-accent' : 'text-fg-2'}`}>Edit</button>
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
                                className="h-5 w-24 shrink-0 rounded text-micro text-fg-3 bg-surface-2 hover:bg-accent/15 hover:text-accent">▼ {c + 1}</button>
                        ))}
                    </div>
                    {/* Row 0 — Scenes */}
                    <div className="flex gap-1 mb-1 items-center">
                        <div className="w-8 shrink-0 text-micro text-fg-3 text-right pr-1">SC</div>
                        {cols.map(c => {
                            const s = sceneAt(c);
                            return s ? (
                                <div key={c} onMouseEnter={() => onPreloadScene?.(s)}
                                    className={`${cellBase} bg-sel-surface/5 group ${activeSceneId === s.id ? 'border-sel-surface' : 'border-sel-surface/40'}`}
                                    style={activeSceneId === s.id && s.accent ? { borderColor: s.accent } : undefined}>
                                    <div className="flex items-center gap-1">
                                        {s.accent && <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ background: s.accent }} />}
                                        <button onClick={() => onRecallScene(s)} className="px-1 rounded bg-accent/15 text-accent hover:bg-accent/25 text-micro font-semibold" title="GO">GO</button>
                                        {editSceneId === s.id ? (
                                            <input autoFocus value={editSceneName} onChange={e => setEditSceneName(e.target.value)}
                                                onBlur={() => { if (editSceneName.trim()) onRenameScene(s.id, editSceneName.trim()); setEditSceneId(null); }}
                                                onKeyDown={e => { if (e.key === 'Enter') { if (editSceneName.trim()) onRenameScene(s.id, editSceneName.trim()); setEditSceneId(null); } if (e.key === 'Escape') setEditSceneId(null); }}
                                                className="flex-1 min-w-0 bg-surface-1 border border-line-2 rounded px-1 text-fg-1 text-micro" />
                                        ) : (
                                            <span className="truncate flex-1 text-fg-1 cursor-text" title="Double-click to rename" onDoubleClick={() => { setEditSceneId(s.id); setEditSceneName(s.name); }}>{s.name}</span>
                                        )}
                                    </div>
                                    <div className="flex items-center justify-between text-fg-3">
                                        <input type="number" min={0} step={0.1} value={s.fadeSec ?? 0} onChange={e => onUpdateSceneFade(s.id, Math.max(0, Number(e.target.value) || 0))}
                                            title="Crossfade (s)" className="w-9 bg-transparent hover:bg-surface-1 border border-transparent hover:border-line-1 rounded px-0.5 text-fg-3 tabular-nums" />
                                        {/* A scene that recalls audio SAYS SO, always — not only on hover. In an unattended
                                            install the operator has to be able to see which scenes touch the sound. */}
                                        {!!sceneAudioEntries(s).length && <span className="text-accent shrink-0" title={`${sceneAudioEntries(s).length} audio param(s) recalled`}>♪{sceneAudioEntries(s).length}</span>}
                                        <span className="opacity-0 group-hover:opacity-100 flex gap-1">
                                            {onUpdateSceneAudio && <button onClick={() => { setAudioSceneId(s.id); setSelCueId(null); setMode('edit'); setAddOpen(true); }}
                                                title="Bind audio params to this scene" className="hover:text-fg-1"><Music size={10} /></button>}
                                            {onEditScene && <button onClick={() => onEditScene(s.id)} title="Edit this state's timeline" className="hover:text-fg-1"><Film size={10} /></button>}
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
                            <div className="w-8 shrink-0 text-micro text-fg-3 text-right pr-1">{r}</div>
                            {cols.map(c => {
                                const cue = cueAt(r, c);
                                if (!cue) return (
                                    <button key={c} onClick={() => addCue(r, c)} className={`${cellBase} border-dashed border-line-1 text-fg-3 hover:border-accent hover:text-accent items-center justify-center`}>
                                        <Plus size={12} />
                                    </button>
                                );
                                const sel = cue.id === selCueId;
                                return (
                                    <div key={c} role="button" tabIndex={0} onClick={() => cellClick(cue)}
                                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cellClick(cue); } }}
                                        title={mode === 'live' ? 'Fire cue' : 'Edit cue'}
                                        className={`${cellBase} cursor-pointer group ${sel ? 'border-accent bg-accent/10' : 'border-line-2 bg-surface-2 hover:bg-surface-3'}`}
                                        style={cue.color ? { borderColor: cue.color } : undefined}>
                                        <div className="flex items-center gap-1">
                                            <Zap size={9} className="text-accent shrink-0" />
                                            <span className="truncate flex-1 text-fg-1" title={cue.name}>{cue.name}</span>
                                        </div>
                                        <div className="flex items-center justify-between text-fg-3">
                                            <span>{cueEntries(cue.entries).length}p · {(cue.fadeSec ?? 0).toFixed(1)}s</span>
                                            <button onClick={(e) => { e.stopPropagation(); removeCue(cue.id); }} className="opacity-0 group-hover:opacity-100 hover:text-danger" title="Delete cue"><Trash2 size={10} /></button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>

                {/* Inspector (edit mode) — one panel, two targets: the selected CUE, or a scene's ♪ audio list. */}
                {mode === 'edit' && target && (
                    <div className="w-64 shrink-0 border-l border-line-1 bg-surface-1 overflow-auto p-2 space-y-2">
                        {audioScene ? (
                            <>
                                <div className="flex items-center gap-1">
                                    <span className="flex-1 min-w-0 truncate text-fg-1 text-mini inline-flex items-center gap-1"><Music size={12} className="text-accent shrink-0" />{audioScene.name}</span>
                                    <button onClick={() => setAudioSceneId(null)} className="text-fg-3 hover:text-fg-1"><X size={14} /></button>
                                </div>
                                {/* The scene's LOOK is a snapshot (Capture / Update Scene). Its AUDIO is this explicit
                                    list — nothing here is auto-captured, so Update Scene can never clobber it. */}
                                <div className="text-micro text-fg-3">
                                    Audio params recalled on GO. Each fades over the scene's fade ({(audioScene.fadeSec ?? 0).toFixed(1)}s) unless it overrides it below. An automation lane on the same path always wins.
                                </div>
                            </>
                        ) : selCue ? (
                            <>
                                <div className="flex items-center gap-1">
                                    <input value={selCue.name} onChange={e => patchCue(selCue.id, { name: e.target.value })}
                                        className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-1.5 py-1 text-fg-1 text-mini" />
                                    <button onClick={() => setSelCueId(null)} className="text-fg-3 hover:text-fg-1"><X size={14} /></button>
                                </div>
                                <div className="flex items-center gap-2 text-micro">
                                    <label className="text-fg-3">Fade</label>
                                    <input type="number" min={0} step={0.1} value={selCue.fadeSec} onChange={e => patchCue(selCue.id, { fadeSec: Math.max(0, Number(e.target.value) || 0) })}
                                        className="w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 tabular-nums" />
                                    <select value={selCue.transition} onChange={e => patchCue(selCue.id, { transition: e.target.value as CueTransition })}
                                        className="flex-1 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1">
                                        {TRANSITIONS.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <label className="flex items-center gap-1.5 text-micro text-fg-2"><input type="checkbox" checked={!!selCue.restartMedia} onChange={e => patchCue(selCue.id, { restartMedia: e.target.checked })} /> Restart media on fire</label>
                            </>
                        ) : null}

                        {/* Entries */}
                        <div className="flex items-center justify-between pt-1">
                            <span className="text-micro text-fg-3 uppercase tracking-wide">{target.audioOnly ? 'Audio' : 'Parameters'} ({target.entries.length})</span>
                            <button onClick={() => setAddOpen(o => !o)} className="text-accent text-micro hover:underline inline-flex items-center gap-0.5"><Plus size={11} /> capture</button>
                        </div>
                        <div className="space-y-1">
                            {target.entries.map(e => (
                                <div key={e.path} className="rounded bg-surface-0/40 px-1 py-1 space-y-1">
                                    <div className="flex items-center gap-1 text-micro">
                                        <span className="flex-1 min-w-0 truncate text-fg-2" title={e.path}>{labelForPath(e.path)}</span>
                                        <EntryValue value={e.value} range={pluginRanges.get(e.path)} onChange={(v) => setEntryValue(e.path, v)} />
                                        <button onClick={() => removeEntry(e.path)} className="text-fg-3 hover:text-danger"><Trash2 size={10} /></button>
                                    </div>
                                    {isFadeablePath(e.path) && (
                                        <div className="flex items-center gap-1 text-micro pl-1 text-fg-3">
                                            <span className="opacity-70">fade</span>
                                            <input type="number" min={0} step={0.1} value={e.fadeSec ?? ''} placeholder={target.audioOnly ? 'scene' : 'cue'}
                                                onChange={(ev) => setEntryFade(e.path, ev.target.value === '' ? undefined : Math.max(0, Number(ev.target.value) || 0))}
                                                title={target.audioOnly ? "Per-entry fade (s) — blank inherits the scene's fade" : "Per-entry fade (s) — blank inherits the cue's fade"}
                                                className="w-10 bg-surface-0 border border-line-1 rounded px-0.5 text-fg-1 tabular-nums" />
                                            <select value={e.transition ?? ''}
                                                onChange={(ev) => setEntryTransition(e.path, ev.target.value === '' ? undefined : ev.target.value as CueTransition)}
                                                title={target.audioOnly ? "Per-entry transition — blank inherits the scene's (smooth)" : "Per-entry transition — 'cue' inherits the cue's"}
                                                className="flex-1 min-w-0 bg-surface-0 border border-line-1 rounded px-0.5 py-0.5 text-fg-1">
                                                <option value="">{target.audioOnly ? 'scene' : 'cue'}</option>
                                                {TRANSITIONS.map(t => <option key={t} value={t}>{t}</option>)}
                                            </select>
                                        </div>
                                    )}
                                </div>
                            ))}
                            {target.entries.length === 0 && <div className="text-fg-3 italic text-micro">No params — use “capture” to add some.</div>}
                        </div>

                        {/* Capture picker */}
                        {addOpen && (
                            <div className="border border-line-1 rounded p-1.5 bg-surface-0 space-y-1.5 max-h-48 overflow-auto">
                                {/* A SCENE target carries AUDIO params only: its look is a snapshot, captured by
                                    Capture / Update Scene, not by this picker. */}
                                {!target.audioOnly && <>
                                    <CaptureGroup title="Global" defs={globalParams()} entries={target.entries} onCapture={captureEntry} />
                                    {surfaces.map(s => <CaptureGroup key={s.id} title={s.name} defs={surfaceParams(s)} entries={target.entries} onCapture={captureEntry} />)}
                                    {fixtures.map(f => <CaptureGroup key={f.id} title={f.name} defs={fixtureParams(f)} entries={target.entries} onCapture={captureEntry} />)}
                                </>}
                                {pluginParamGroups.map(g => (
                                    <CaptureGroup key={g.title} title={g.title} defs={g.defs} entries={target.entries} onCapture={captureEntry} />
                                ))}
                                {target.audioOnly && pluginParamGroups.length === 0 && (
                                    <div className="text-fg-3 italic text-micro">No audio params — load the audio plugin and add clips to the bed.</div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Footer hint */}
            <div className="shrink-0 px-3 py-1 border-t border-line-1 bg-surface-2 text-fg-3 text-micro truncate">
                {selCue ? <>OSC: <code>{oscPrefix}/cue/{selCue.id}/go</code></> : <>Live: click to fire · Edit: click to author · column ▼ fires the whole column</>}
            </div>
        </div>
    );
};

// `entries`, not `cue`: the group only ever read cue.entries, and the picker now commits into a CaptureTarget
// (a Cue or a Scene's audio list). Taking the list rather than the owner is what lets both share this UI.
const CaptureGroup: React.FC<{ title: string; defs: ParamDef[]; entries: CueEntry[]; onCapture: (d: ParamDef) => void }> = ({ title, defs, entries, onCapture }) => (
    <div>
        <div className="text-micro text-fg-3 uppercase tracking-wide mb-0.5">{title}</div>
        <div className="flex flex-wrap gap-1">
            {defs.map(d => {
                const has = entries.some(e => e.path === d.path);
                return (
                    <button key={d.path} onClick={() => onCapture(d)} title={has ? 'Update captured value' : 'Capture current value'}
                        className={`px-1.5 py-0.5 rounded text-micro border ${has ? 'border-accent/50 bg-accent/15 text-accent' : 'border-line-1 text-fg-2 hover:bg-surface-3'}`}>{d.label}</button>
                );
            })}
        </div>
    </div>
);

// A number entry: DRAFT LOCALLY, COMMIT ONCE — clamped — ON BLUR/ENTER.
//
// ⚠ THE DRAFT IS WHAT MAKES THE CLAMP SAFE TO HAVE. Clamping per KEYSTROKE is worse than not clamping: on a
// 20 Hz–20 kHz cutoff, the first digit of "2000" is `2`, which is below min, so a live clamp snaps the box
// to `20` — and the operator, typing on, lands on 20000. The number they meant is unreachable. So the box
// holds a string while it is being typed, and exactly one clamped number is committed when they leave it
// (Escape abandons; an empty or unparseable box reverts to the authored value rather than committing NaN,
// which would reach the fade engine as a permanent silent leg).
// ⚠ THE REF IS WHAT MAKES *ESCAPE* REAL. Escape must abandon; blur/Enter must commit; and both leave through
// the SAME onBlur, because `.blur()` dispatches focusout SYNCHRONOUSLY inside the keydown stack — where the
// batched `setDraft(null)` has not re-rendered yet. So an onBlur that read the DOM (`e.target.value`) or a
// stale closure would still see the discarded text and COMMIT IT: Escape on a mistyped `2` for
// audio.master.gain would author 1.5 into the scene, clamped but wrong, in a document that runs unattended.
// A cancel that does the opposite of cancel. `set(null)` clears the ref SYNCHRONOUSLY, so the commit that
// fires a moment later sees null and no-ops. (AudioBedPanel's TrackName documents and solves the same trap.)
const NumberEntry: React.FC<{ value: number; range?: { min: number; max: number; step?: number }; onCommit: (v: number) => void }> = ({ value, range, onCommit }) => {
    const [draft, setDraft] = useState<string | null>(null);
    const draftRef = useRef<string | null>(null);
    const set = (v: string | null) => { draftRef.current = v; setDraft(v); };
    const commit = () => {
        const raw = draftRef.current;
        set(null);   // either way, fall back to rendering the committed value
        if (raw === null) return;   // Escape already abandoned it — or the box was never touched
        const n = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(n)) onCommit(range ? Math.min(range.max, Math.max(range.min, n)) : n);
    };
    return (
        <input type="number" min={range?.min} max={range?.max} step={range?.step ?? 0.01}
            value={draft ?? String(value)}
            onChange={e => set(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur();
                else if (e.key === 'Escape') { set(null); e.currentTarget.blur(); }
            }}
            title={range ? `${range.min} … ${range.max} — Enter to commit` : undefined}
            className="w-14 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1 tabular-nums" />
    );
};

// `range` — the target's own min/max, when we know it (plugin params; enumerate() declares one for every
// target it emits). It bounds the spinner, titles the field and clamps the commit, so the limit is VISIBLE
// rather than a level event. Core paths have never declared one; they render exactly as before.
const EntryValue: React.FC<{ value: CueEntry['value']; range?: { min: number; max: number; step?: number }; onChange: (v: CueEntry['value']) => void }> = ({ value, range, onChange }) => {
    if (typeof value === 'number') return <NumberEntry value={value} range={range} onCommit={onChange} />;
    if (typeof value === 'boolean') return <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />;
    return <input type="text" value={String(value ?? '')} onChange={e => onChange(e.target.value)} className="w-20 bg-surface-0 border border-line-1 rounded px-1 py-0.5 text-fg-1" />;
};

// Short label from a dot-path leaf (e.g. surfaces.s1.content.opacity → "surf · opacity").
//
// HEAD-AWARE — via pathLeaf, which OWNS the grammar. A bare slice(2) was wrong for audio in two ways at
// once: the leaf landed mid-path (`audio.clip.c7.gain` read as the leaf `c7.gain`), and the owner ternary
// had no `else`, so EVERY non-surfaces head was labelled `fix` — `audio.master.gain` rendered as
// "fix · gain", with the word *master* gone entirely. On a desk that is a mislabelled cue: the operator
// reads "fix" and fires it expecting a light.
function labelForPath(path: string): string {
    if (path === 'globalBrightness') return 'LED Brightness';
    const parts = path.split('.');
    const leaf = pathLeaf(path).replace(/^content\./, '');
    if (parts[0] === 'surfaces') return `surf · ${leaf}`;
    if (parts[0] === 'fixtures') return `fix · ${leaf}`;
    if (parts[0] === 'audio') {
        // audio.master.<leaf>  /  audio.clip.<id>.<leaf>  /  audio.track.<id>.<leaf>
        const what = parts[1] === 'master' ? 'master' : `${parts[1]} ${(parts[2] ?? '').slice(0, 6)}`;
        return `♪ ${what} · ${leaf}`;
    }
    return `${parts[0]} · ${leaf}`;   // an unknown plugin namespace: say its name, don't call it a fixture
}
