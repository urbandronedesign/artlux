import React, { useState, useEffect, useRef } from 'react';
import { Fixture, FixtureGroup, Scene, Surface, FixtureTemplate } from '../types';
import { Plus, Trash2, Folder, Box, Users, Camera, Play, Copy, Layers, Save, PackagePlus, Hash } from 'lucide-react';

interface ScenePanelProps {
    surfaces: Surface[];
    selectedSurfaceId: string | null;
    onSelectSurface: (id: string) => void;
    onAddSurface: () => void;
    onRemoveSurface: (id: string) => void;
    onRenameSurface: (id: string, newName: string) => void;
    fixtures: Fixture[];
    selectedFixtureId: string | null;
    onSelect: (id: string) => void;
    onAdd: () => void;
    onRemove: (id: string) => void;
    onRename: (id: string, newName: string) => void;
    masterBrightness: number;
    onMasterBrightnessChange: (val: number) => void;
    groups: FixtureGroup[];
    scenes: Scene[];
    onCreateGroup: () => void;
    onAddSelectedToGroup: (groupId: string) => void;
    onRemoveGroup: (groupId: string) => void;
    onSelectGroup: (group: FixtureGroup) => void;
    onApplyLookToGroup: (group: FixtureGroup) => void;
    onCaptureScene: () => void;
    onRecallScene: (scene: Scene) => void;
    onRemoveScene: (id: string) => void;
    templates: FixtureTemplate[];
    onSaveTemplate: () => void;
    onAddFromTemplate: (t: FixtureTemplate) => void;
    onRemoveTemplate: (id: string) => void;
    onAutoPatch: () => void;
}

export const ScenePanel: React.FC<ScenePanelProps> = ({
    surfaces,
    selectedSurfaceId,
    onSelectSurface,
    onAddSurface,
    onRemoveSurface,
    onRenameSurface,
    fixtures,
    selectedFixtureId,
    onSelect,
    onAdd,
    onRemove,
    onRename,
    masterBrightness,
    onMasterBrightnessChange,
    groups,
    scenes,
    onCreateGroup,
    onAddSelectedToGroup,
    onRemoveGroup,
    onSelectGroup,
    onApplyLookToGroup,
    onCaptureScene,
    onRecallScene,
    onRemoveScene,
    templates,
    onSaveTemplate,
    onAddFromTemplate,
    onRemoveTemplate,
    onAutoPatch,
}) => {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editKind, setEditKind] = useState<'fixture' | 'surface'>('fixture');
    const [editName, setEditName] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editingId && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [editingId]);

    const startEditing = (id: string, name: string, kind: 'fixture' | 'surface') => {
        setEditingId(id);
        setEditKind(kind);
        setEditName(name);
    };

    const commitEditing = () => {
        if (editingId && editName.trim()) {
            if (editKind === 'surface') onRenameSurface(editingId, editName.trim());
            else onRename(editingId, editName.trim());
        }
        setEditingId(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commitEditing();
        if (e.key === 'Escape') setEditingId(null);
    };

    return (
        <div className="flex flex-col h-full bg-surface-1 border-l border-line-1 text-xs">
            {/* Surfaces */}
            <div className="border-b border-line-1">
                <div className="h-8 bg-surface-2 flex items-center px-2 justify-between border-b border-line-1">
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px]">Surfaces</span>
                    <button onClick={onAddSurface} className="text-fg-2 hover:text-fg-1" title="Add Surface"><Plus size={14}/></button>
                </div>
                <div className="p-1 space-y-0.5 max-h-40 overflow-y-auto">
                    {surfaces.map(s => {
                        const sel = s.id === selectedSurfaceId;
                        return (
                            <div
                                key={s.id}
                                onClick={() => onSelectSurface(s.id)}
                                onDoubleClick={() => startEditing(s.id, s.name, 'surface')}
                                className={`flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${sel ? 'bg-sel-surface/20 text-fg-1' : 'text-fg-2 hover:bg-surface-3'}`}
                            >
                                <Layers size={12} className={`mr-2 ${sel ? 'text-sel-surface' : 'text-fg-3'}`} />
                                {editingId === s.id ? (
                                    <input
                                        ref={inputRef}
                                        type="text"
                                        value={editName}
                                        onChange={(e) => setEditName(e.target.value)}
                                        onBlur={commitEditing}
                                        onKeyDown={handleKeyDown}
                                        className="flex-1 bg-black text-white border border-sel-surface text-xs px-1 py-0.5 rounded outline-none min-w-0"
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                ) : (
                                    <span className="flex-1 truncate select-none" title="Double-click to rename">{s.name}</span>
                                )}
                                <span className="num text-[9px] text-fg-3 mr-1 uppercase">{s.content.type === 'NONE' ? '—' : s.content.type}</span>
                                <button
                                    className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-danger text-fg-3"
                                    onClick={(e) => { e.stopPropagation(); onRemoveSurface(s.id); }}
                                    title="Remove Surface"
                                ><Trash2 size={10} /></button>
                            </div>
                        );
                    })}
                    {surfaces.length === 0 && <div className="text-fg-3 italic px-2 py-1">No surfaces</div>}
                </div>
            </div>

            {/* Header */}
            <div className="h-8 bg-surface-2 flex items-center px-2 justify-between border-b border-line-1">
                <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px]">Fixtures</span>
                <div className="flex gap-1.5">
                     <button onClick={onAutoPatch} className="text-fg-2 hover:text-fg-1" title="Auto-patch (assign universes/addresses)"><Hash size={13}/></button>
                     <button onClick={onAdd} className="text-fg-2 hover:text-fg-1" title="Add Fixture"><Plus size={14}/></button>
                </div>
            </div>

            {/* Tree View */}
            <div className="flex-1 overflow-y-auto p-1">
                {/* Mock Folder for visual structure */}
                <div className="mb-1">
                    <div className="flex items-center px-2 py-1 text-fg-2 hover:bg-surface-3 rounded cursor-default">
                         <Folder size={12} className="mr-2 text-fg-3" />
                         <span className="font-medium">Master Layer</span>
                    </div>
                    <div className="pl-4 border-l border-line-1 ml-2.5 mt-1 space-y-0.5">
                        {fixtures.map(f => {
                            const isSelected = f.id === selectedFixtureId;
                            return (
                                <div 
                                    key={f.id}
                                    onClick={() => onSelect(f.id)}
                                    onDoubleClick={() => startEditing(f.id, f.name, 'fixture')}
                                    className={`flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${isSelected ? 'bg-accent/20 text-white' : 'text-fg-2 hover:bg-surface-3'}`}
                                >
                                    <Box size={12} className={`mr-2 ${isSelected ? 'text-accent' : 'text-fg-3'}`} />
                                    
                                    {editingId === f.id ? (
                                        <input 
                                            ref={inputRef}
                                            type="text"
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            onBlur={commitEditing}
                                            onKeyDown={handleKeyDown}
                                            className="flex-1 bg-black text-white border border-accent text-xs px-1 py-0.5 rounded outline-none min-w-0"
                                            onClick={(e) => e.stopPropagation()} 
                                        />
                                    ) : (
                                        <span className="flex-1 truncate select-none" title="Double-click to rename">{f.name}</span>
                                    )}
                                    
                                    <div className="opacity-0 group-hover:opacity-100 flex gap-1">
                                         <button 
                                            className="p-0.5 hover:text-danger text-fg-3"
                                            onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}
                                            title="Remove Fixture"
                                         >
                                            <Trash2 size={10} />
                                         </button>
                                    </div>
                                    
                                    {/* Active Indicator dots */}
                                    <div className="w-1 h-1 rounded-full bg-ok ml-2 shadow-[0_0_4px_rgba(63,185,80,0.5)]"></div>
                                </div>
                            );
                        })}
                        {fixtures.length === 0 && (
                            <div className="text-fg-3 italic px-2 py-1">No fixtures</div>
                        )}
                    </div>
                </div>
            </div>
            
            {/* Library (fixture templates) */}
            <div className="border-t border-line-1">
                <div className="h-8 bg-surface-2 flex items-center px-2 justify-between border-b border-line-1">
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px]">Library</span>
                    <button onClick={onSaveTemplate} className="text-fg-2 hover:text-fg-1" title="Save selected fixture as a template"><Save size={13}/></button>
                </div>
                <div className="p-1 space-y-0.5 max-h-28 overflow-y-auto">
                    {templates.map(t => (
                        <div key={t.id} className="flex items-center group px-2 py-1 rounded hover:bg-surface-3 text-fg-2">
                            <button className="flex-1 flex items-center text-left truncate" onClick={() => onAddFromTemplate(t)} title="Add a fixture from this template">
                                <PackagePlus size={12} className="mr-2 text-fg-3" />
                                {t.name} <span className="text-fg-3 ml-1">({t.ledCount})</span>
                            </button>
                            <button className="opacity-0 group-hover:opacity-100 hover:text-danger text-fg-3" onClick={() => onRemoveTemplate(t.id)} title="Delete template"><Trash2 size={10} /></button>
                        </div>
                    ))}
                    {templates.length === 0 && <div className="text-fg-3 italic px-2 py-1">No templates</div>}
                </div>
            </div>

            {/* Groups */}
            <div className="border-t border-line-1">
                <div className="h-8 bg-surface-2 flex items-center px-2 justify-between border-b border-line-1">
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px]">Groups</span>
                    <button onClick={onCreateGroup} className="text-fg-2 hover:text-fg-1" title="New group from selection"><Plus size={14}/></button>
                </div>
                <div className="p-1 space-y-0.5 max-h-28 overflow-y-auto">
                    {groups.map(g => (
                        <div key={g.id} className="flex items-center group px-2 py-1 rounded hover:bg-surface-3 text-fg-2">
                            <Users size={12} className="mr-2 text-fg-3" />
                            <button className="flex-1 text-left truncate" onClick={() => onSelectGroup(g)}>{g.name} <span className="text-fg-3">({g.fixtureIds.length})</span></button>
                            <div className="opacity-0 group-hover:opacity-100 flex gap-1.5">
                                <button title="Add selected fixture" onClick={() => onAddSelectedToGroup(g.id)} className="hover:text-accent text-fg-3"><Plus size={11} /></button>
                                <button title="Apply selected look to group" onClick={() => onApplyLookToGroup(g)} className="hover:text-accent text-fg-3"><Copy size={11} /></button>
                                <button title="Delete group" onClick={() => onRemoveGroup(g.id)} className="hover:text-danger text-fg-3"><Trash2 size={10} /></button>
                            </div>
                        </div>
                    ))}
                    {groups.length === 0 && <div className="text-fg-3 italic px-2 py-1">No groups</div>}
                </div>
            </div>

            {/* Scenes */}
            <div className="border-t border-line-1">
                <div className="h-8 bg-surface-2 flex items-center px-2 justify-between border-b border-line-1">
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px]">Scenes</span>
                    <button onClick={onCaptureScene} className="text-fg-2 hover:text-fg-1" title="Capture current look"><Camera size={14}/></button>
                </div>
                <div className="p-1 space-y-0.5 max-h-28 overflow-y-auto">
                    {scenes.map(s => (
                        <div key={s.id} className="flex items-center group px-2 py-1 rounded hover:bg-surface-3 text-fg-2">
                            <button className="flex-1 flex items-center text-left truncate" onClick={() => onRecallScene(s)} title="Recall scene">
                                <Play size={11} className="mr-2 text-fg-3" /> {s.name}
                            </button>
                            <button className="opacity-0 group-hover:opacity-100 hover:text-danger text-fg-3" onClick={() => onRemoveScene(s.id)} title="Delete scene"><Trash2 size={10} /></button>
                        </div>
                    ))}
                    {scenes.length === 0 && <div className="text-fg-3 italic px-2 py-1">No scenes</div>}
                </div>
            </div>

            {/* Global Parameters / Preview (Bottom of Right Panel) */}
            <div className="h-auto border-t border-line-1 bg-surface-1 flex flex-col">
                 <div className="h-8 bg-surface-2 flex items-center px-2 border-b border-line-1">
                    <span className="font-bold text-fg-2 uppercase tracking-wider text-[10px]">Global Params</span>
                </div>
                <div className="p-3 space-y-4">
                     <div>
                         <div className="flex justify-between text-fg-2 mb-1">
                            <span>Master Brightness</span>
                            <span>{Math.round(masterBrightness * 100)}%</span>
                         </div>
                         <input 
                            type="range" 
                            min={0} max={1} step={0.01}
                            value={masterBrightness}
                            onChange={(e) => onMasterBrightnessChange(parseFloat(e.target.value))}
                            className="w-full h-1 bg-line-2 rounded-lg appearance-none cursor-pointer"
                         />
                     </div>
                </div>
            </div>
        </div>
    );
}