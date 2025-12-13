import React, { useState, useEffect, useRef } from 'react';
import { Fixture } from '../types';
import { Plus, Trash2, Folder, Box } from 'lucide-react';

interface ScenePanelProps {
    fixtures: Fixture[];
    selectedFixtureId: string | null;
    onSelect: (id: string) => void;
    onAdd: () => void;
    onRemove: (id: string) => void;
    onRename: (id: string, newName: string) => void;
    masterBrightness: number;
    onMasterBrightnessChange: (val: number) => void;
}

export const ScenePanel: React.FC<ScenePanelProps> = ({
    fixtures,
    selectedFixtureId,
    onSelect,
    onAdd,
    onRemove,
    onRename,
    masterBrightness,
    onMasterBrightnessChange
}) => {
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName, setEditName] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (editingId && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [editingId]);

    const startEditing = (f: Fixture) => {
        setEditingId(f.id);
        setEditName(f.name);
    };

    const commitEditing = () => {
        if (editingId && editName.trim()) {
            onRename(editingId, editName.trim());
        }
        setEditingId(null);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') commitEditing();
        if (e.key === 'Escape') setEditingId(null);
    };

    return (
        <div className="w-64 bg-[#121212] border-l border-[#222] flex flex-col h-full text-xs">
            {/* Header */}
            <div className="h-8 bg-[#161616] flex items-center px-2 justify-between border-b border-[#222]">
                <span className="font-bold text-gray-400 uppercase tracking-wider text-[10px]">Scene Graph</span>
                <div className="flex gap-1">
                     <button onClick={onAdd} className="text-gray-400 hover:text-white" title="Add Fixture"><Plus size={14}/></button>
                </div>
            </div>

            {/* Tree View */}
            <div className="flex-1 overflow-y-auto p-1">
                {/* Mock Folder for visual structure */}
                <div className="mb-1">
                    <div className="flex items-center px-2 py-1 text-gray-400 hover:bg-[#1a1a1a] rounded cursor-default">
                         <Folder size={12} className="mr-2 text-gray-600" />
                         <span className="font-medium">Master Layer</span>
                    </div>
                    <div className="pl-4 border-l border-[#222] ml-2.5 mt-1 space-y-0.5">
                        {fixtures.map(f => {
                            const isSelected = f.id === selectedFixtureId;
                            return (
                                <div 
                                    key={f.id}
                                    onClick={() => onSelect(f.id)}
                                    onDoubleClick={() => startEditing(f)}
                                    className={`flex items-center group px-2 py-1.5 rounded cursor-pointer transition-colors ${isSelected ? 'bg-accent/20 text-white' : 'text-gray-400 hover:bg-[#1a1a1a]'}`}
                                >
                                    <Box size={12} className={`mr-2 ${isSelected ? 'text-accent' : 'text-gray-600'}`} />
                                    
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
                                            className="p-0.5 hover:text-red-400 text-gray-600"
                                            onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}
                                            title="Remove Fixture"
                                         >
                                            <Trash2 size={10} />
                                         </button>
                                    </div>
                                    
                                    {/* Active Indicator dots */}
                                    <div className="w-1 h-1 rounded-full bg-green-500 ml-2 shadow-[0_0_4px_rgba(34,197,94,0.5)]"></div>
                                </div>
                            );
                        })}
                        {fixtures.length === 0 && (
                            <div className="text-gray-700 italic px-2 py-1">No fixtures</div>
                        )}
                    </div>
                </div>
            </div>
            
            {/* Global Parameters / Preview (Bottom of Right Panel) */}
            <div className="h-1/3 border-t border-[#222] bg-[#141414] flex flex-col">
                 <div className="h-8 bg-[#161616] flex items-center px-2 border-b border-[#222]">
                    <span className="font-bold text-gray-400 uppercase tracking-wider text-[10px]">Global Params</span>
                </div>
                <div className="p-3 space-y-4">
                     <div>
                         <div className="flex justify-between text-gray-500 mb-1">
                            <span>Master Brightness</span>
                            <span>{Math.round(masterBrightness * 100)}%</span>
                         </div>
                         <input 
                            type="range" 
                            min={0} max={1} step={0.01}
                            value={masterBrightness}
                            onChange={(e) => onMasterBrightnessChange(parseFloat(e.target.value))}
                            className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer" 
                         />
                     </div>
                     <div>
                         <div className="flex justify-between text-gray-500 mb-1">
                            <span>Speed</span>
                            <span>1.0x</span>
                         </div>
                         <input type="range" className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer" />
                     </div>
                     <div>
                         <div className="flex justify-between text-gray-500 mb-1">
                            <span>Contrast</span>
                            <span>50%</span>
                         </div>
                         <input type="range" className="w-full h-1 bg-[#333] rounded-lg appearance-none cursor-pointer" />
                     </div>
                </div>
            </div>
        </div>
    );
}