import React, { useEffect, useRef, useState } from 'react';
import { Scene } from '../types';
import { Plus, Trash2, Play, RefreshCw, Radio, GitBranch } from 'lucide-react';

interface Props {
    scenes: Scene[];
    oscPrefix: string;
    onCaptureScene: () => void;
    onRecallScene: (scene: Scene) => void;
    onUpdateScene: (id: string) => void;
    onRenameScene: (id: string, name: string) => void;
    onUpdateSceneFade: (id: string, fadeSec: number) => void;
    onRemoveScene: (id: string) => void;
}

// Dock panel (next to Timeline) for Scenes & Cues — named look snapshots recallable manually,
// from the timeline state machine, or over OSC. See docs/SCENES.md. Recall snaps in this version;
// the fade field is stored for a future crossfade engine.
export const ScenesCuesPanel: React.FC<Props> = ({
    scenes, oscPrefix, onCaptureScene, onRecallScene, onUpdateScene, onRenameScene, onUpdateSceneFade, onRemoveScene,
}) => {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { if (editingId && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, [editingId]);

    const startEdit = (s: Scene) => { setEditingId(s.id); setEditName(s.name); };
    const commitEdit = () => { if (editingId && editName.trim()) onRenameScene(editingId, editName.trim()); setEditingId(null); };
    const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') commitEdit(); if (e.key === 'Escape') setEditingId(null); };

    return (
        <div className="h-full flex flex-col text-fg-2 text-[12px]">
            {/* Toolbar */}
            <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line-1 bg-surface-2">
                <span className="text-fg-1 font-medium">Scenes &amp; Cues</span>
                <span className="text-fg-3 text-[11px]">{scenes.length} scene{scenes.length === 1 ? '' : 's'}</span>
                <button
                    onClick={onCaptureScene}
                    className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded-[var(--r-sm)] bg-accent/15 text-accent hover:bg-accent/25 text-[11px]"
                    title="Capture the current look as a new scene"
                >
                    <Plus size={13} /> Capture scene
                </button>
            </div>

            {/* List */}
            <div className="flex-1 min-h-0 overflow-auto">
                {scenes.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center gap-1 text-fg-3">
                        <span className="italic">No scenes yet.</span>
                        <span className="text-[11px]">Set up a look, then “Capture scene” to store it.</span>
                    </div>
                ) : (
                    <table className="w-full border-collapse">
                        <thead>
                            <tr className="text-fg-3 text-[10px] uppercase tracking-wide">
                                <th className="text-left font-medium px-3 py-1.5 w-16"></th>
                                <th className="text-left font-medium px-2 py-1.5">Name</th>
                                <th className="text-left font-medium px-2 py-1.5 w-20">Fade (s)</th>
                                <th className="text-left font-medium px-2 py-1.5">OSC trigger</th>
                                <th className="text-right font-medium px-3 py-1.5 w-20"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {scenes.map((s, i) => (
                                <tr key={s.id} className="group border-t border-line-1 hover:bg-surface-3/60">
                                    <td className="px-3 py-1.5">
                                        <button
                                            onClick={() => onRecallScene(s)}
                                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-accent/15 text-accent hover:bg-accent/25 text-[10px] font-semibold tracking-wide"
                                            title="GO — recall this scene"
                                        >
                                            <Play size={10} /> GO
                                        </button>
                                    </td>
                                    <td className="px-2 py-1.5">
                                        {editingId === s.id ? (
                                            <input
                                                ref={inputRef}
                                                className="w-full bg-surface-1 border border-line-2 rounded px-1.5 py-0.5 text-fg-1"
                                                value={editName}
                                                onChange={(e) => setEditName(e.target.value)}
                                                onBlur={commitEdit}
                                                onKeyDown={onKey}
                                            />
                                        ) : (
                                            <span className="text-fg-1 cursor-text" onDoubleClick={() => startEdit(s)} title="Double-click to rename">
                                                <span className="text-fg-3 mr-1.5 tabular-nums">{i + 1}.</span>{s.name}
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <input
                                            type="number" min={0} step={0.1}
                                            value={s.fadeSec ?? 0}
                                            onChange={(e) => onUpdateSceneFade(s.id, Math.max(0, Number(e.target.value) || 0))}
                                            className="w-16 bg-surface-1 border border-line-1 rounded px-1.5 py-0.5 text-fg-3 tabular-nums opacity-70"
                                            title="Fade time (seconds) — stored for a future crossfade; recall is instant in this version"
                                        />
                                    </td>
                                    <td className="px-2 py-1.5">
                                        <code className="inline-flex items-center gap-1 text-[10px] text-fg-3" title="Send this OSC address to recall the scene (also: /scene/recall <name|id>)">
                                            <Radio size={10} /> {oscPrefix}/scene/{s.id}/go
                                        </code>
                                    </td>
                                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                        <button className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-fg-1 mr-2" onClick={() => onUpdateScene(s.id)} title="Update scene from the current look"><RefreshCw size={13} /></button>
                                        <button className="opacity-0 group-hover:opacity-100 text-fg-3 hover:text-danger" onClick={() => onRemoveScene(s.id)} title="Delete scene"><Trash2 size={13} /></button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Footer hint */}
            <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 border-t border-line-1 bg-surface-2 text-fg-3 text-[10px]">
                <GitBranch size={11} /> Trigger from the timeline state machine with a “Recall Scene” entry action, or over OSC.
            </div>
        </div>
    );
};
