import React, { useState, useEffect, useRef } from 'react';
import { Fixture, FixtureGroup, Surface } from '../types';
import { Plus, Trash2, Folder, Box, Users, Copy, Layers, Hash, SlidersHorizontal, ChevronUp, ChevronDown } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import { Slider } from './ui';
import { livePreview } from '../services/livePreview';

interface ScenePanelProps {
    surfaces: Surface[];
    selectedSurfaceId: string | null;
    onSelectSurface: (id: string) => void;
    onAddSurface: () => void;
    onRemoveSurface: (id: string) => void;
    onRenameSurface: (id: string, newName: string) => void;
    onMoveSurface: (id: string, dir: 'up' | 'down') => void;
    fixtures: Fixture[];
    selectedFixtureId: string | null;
    selectedFixtureIds: string[];
    onSelect: (id: string, additive?: boolean) => void;
    onSelectFixtures: (ids: string[]) => void;
    onSelectAll: () => void;
    onAdd: () => void;
    onRemove: (id: string) => void;
    onRename: (id: string, newName: string) => void;
    masterBrightness: number;
    onMasterBrightnessChange: (val: number) => void;
    projectorBrightness: number;
    onProjectorBrightnessChange: (val: number) => void;
    onProjectorBrightnessInput: (val: number) => void;
    groups: FixtureGroup[];
    onCreateGroup: () => void;
    onAddSelectedToGroup: (groupId: string) => void;
    onRemoveGroup: (groupId: string) => void;
    onSelectGroup: (group: FixtureGroup) => void;
    onApplyLookToGroup: (group: FixtureGroup) => void;
    onAutoPatch: () => void;
}

export const ScenePanel: React.FC<ScenePanelProps> = ({
    surfaces,
    selectedSurfaceId,
    onSelectSurface,
    onAddSurface,
    onRemoveSurface,
    onRenameSurface,
    onMoveSurface,
    fixtures,
    selectedFixtureId,
    selectedFixtureIds,
    onSelect,
    onSelectFixtures,
    onSelectAll,
    onAdd,
    onRemove,
    onRename,
    masterBrightness,
    onMasterBrightnessChange,
    projectorBrightness,
    onProjectorBrightnessChange,
    onProjectorBrightnessInput,
    groups,
    onCreateGroup,
    onAddSelectedToGroup,
    onRemoveGroup,
    onSelectGroup,
    onApplyLookToGroup,
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

    // Click selection: plain = single, ctrl/cmd = toggle, shift = range from primary.
    const handleFixtureClick = (e: React.MouseEvent, id: string) => {
        if (e.shiftKey && selectedFixtureId) {
            const order = fixtures.map(f => f.id);
            const a = order.indexOf(selectedFixtureId);
            const b = order.indexOf(id);
            if (a !== -1 && b !== -1) {
                const [lo, hi] = a < b ? [a, b] : [b, a];
                onSelectFixtures(order.slice(lo, hi + 1));
                return;
            }
        }
        onSelect(id, e.ctrlKey || e.metaKey);
    };

    return (
        <div className="flex flex-col h-full min-h-0 bg-surface-1 text-xs">
            {/* Surfaces */}
            <CollapsibleSection
                title="Surfaces"
                icon={<Layers size={12} />}
                grow
                action={<button onClick={onAddSurface} className="text-fg-2 hover:text-fg-1" title="Add Surface"><Plus size={14}/></button>}
            >
                <div className="p-1 space-y-0.5">
                    {/* Front-most on top (stage draws low→high zIndex). Use ▲/▼ to restack. */}
                    {[...surfaces].sort((a, b) => (b.zIndex - a.zIndex) || (surfaces.indexOf(b) - surfaces.indexOf(a))).map((s, idx, arr) => {
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
                                <div className="flex items-center text-fg-3">
                                    <button
                                        className="p-0.5 hover:text-fg-1 disabled:opacity-20 disabled:hover:text-fg-3"
                                        disabled={idx === 0}
                                        onClick={(e) => { e.stopPropagation(); onMoveSurface(s.id, 'up'); }}
                                        title="Bring forward"
                                    ><ChevronUp size={12} /></button>
                                    <button
                                        className="p-0.5 hover:text-fg-1 disabled:opacity-20 disabled:hover:text-fg-3"
                                        disabled={idx === arr.length - 1}
                                        onClick={(e) => { e.stopPropagation(); onMoveSurface(s.id, 'down'); }}
                                        title="Send backward"
                                    ><ChevronDown size={12} /></button>
                                    <button
                                        className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-danger ml-0.5"
                                        onClick={(e) => { e.stopPropagation(); onRemoveSurface(s.id); }}
                                        title="Remove Surface"
                                    ><Trash2 size={10} /></button>
                                </div>
                            </div>
                        );
                    })}
                    {surfaces.length === 0 && <div className="text-fg-3 italic px-2 py-1">No surfaces</div>}
                </div>
            </CollapsibleSection>

            {/* Fixtures tree (outliner) */}
            <CollapsibleSection
                title="Fixtures"
                icon={<Box size={12} />}
                grow
                action={<>
                    <button onClick={onAutoPatch} className="text-fg-2 hover:text-fg-1" title="Auto-patch (assign universes/addresses)"><Hash size={13}/></button>
                    <button onClick={onAdd} className="text-fg-2 hover:text-fg-1" title="Add Fixture"><Plus size={14}/></button>
                </>}
            >
                <div className="p-1">
                {/* Mock Folder for visual structure */}
                <div className="mb-1">
                    <div
                        onClick={onSelectAll}
                        className="flex items-center px-2 py-1 text-fg-2 hover:bg-surface-3 rounded cursor-pointer"
                        title="Select all fixtures"
                    >
                         <Folder size={12} className="mr-2 text-fg-3" />
                         <span className="font-medium">Master Layer</span>
                         {fixtures.length > 0 && <span className="ml-auto text-[9px] text-fg-3">{fixtures.length}</span>}
                    </div>
                    <div className="pl-4 border-l border-line-1 ml-2.5 mt-1 space-y-0.5">
                        {fixtures.map(f => {
                            const isSelected = selectedFixtureIds.includes(f.id);
                            return (
                                <div
                                    key={f.id}
                                    onClick={(e) => handleFixtureClick(e, f.id)}
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
            </CollapsibleSection>

            {/* Groups */}
            <CollapsibleSection
                title="Groups"
                icon={<Users size={12} />}
                action={<button onClick={onCreateGroup} className="text-fg-2 hover:text-fg-1" title="New group from selection"><Plus size={14}/></button>}
            >
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
            </CollapsibleSection>

            {/* Global Parameters (sliders) */}
            <CollapsibleSection title="Global Params" icon={<SlidersHorizontal size={12} />}>
                <div className="p-3 space-y-4">
                     <Slider
                        label="LED Brightness"
                        value={masterBrightness}
                        min={0} max={1} step={0.01}
                        format={(v) => `${Math.round(v * 100)}%`}
                        onInput={(v) => livePreview.setBrightness(v)}
                        onChange={onMasterBrightnessChange}
                     />
                     <Slider
                        label="Projector Brightness"
                        value={projectorBrightness}
                        min={0} max={1} step={0.01}
                        format={(v) => `${Math.round(v * 100)}%`}
                        onInput={onProjectorBrightnessInput}
                        onChange={onProjectorBrightnessChange}
                     />
                </div>
            </CollapsibleSection>
        </div>
    );
}