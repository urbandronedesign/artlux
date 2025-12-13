import React from 'react';
import { Fixture } from '../types';
import { Button } from './Button';
import { Plus, Trash2, Settings, RotateCw } from 'lucide-react';

interface FixtureListProps {
  fixtures: Fixture[];
  selectedFixtureId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<Fixture>) => void;
}

export const FixtureList: React.FC<FixtureListProps> = ({
  fixtures,
  selectedFixtureId,
  onSelect,
  onAdd,
  onRemove,
  onUpdate
}) => {
  return (
    <div className="flex flex-col h-full bg-slate-900 border-r border-slate-700 w-72">
      <div className="p-4 border-b border-slate-700 bg-slate-800">
         <div className="flex justify-between items-center mb-4">
             <h2 className="font-bold text-white text-lg tracking-tight">ARTLUX</h2>
             <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" title="Engine Running"></div>
         </div>
         <Button onClick={onAdd} className="w-full" icon={<Plus size={16} />}>
            Add Fixture
         </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-2 space-y-1">
            {fixtures.map(f => {
                const isSelected = f.id === selectedFixtureId;
                return (
                    <div key={f.id} className={`rounded-md overflow-hidden transition-all ${isSelected ? 'bg-slate-700 ring-1 ring-blue-500' : 'hover:bg-slate-800'}`}>
                        <div 
                            className="flex items-center p-3 cursor-pointer"
                            onClick={() => onSelect(f.id)}
                        >
                           <span className="flex-1 text-sm font-medium text-slate-200">{f.name}</span>
                           <Button 
                              variant="ghost" 
                              size="sm" 
                              className="text-slate-400 hover:text-red-400 p-1 h-auto"
                              onClick={(e) => { e.stopPropagation(); onRemove(f.id); }}
                            >
                               <Trash2 size={14} />
                           </Button>
                        </div>
                        
                        {isSelected && (
                            <div className="px-3 pb-3 pt-0 text-xs space-y-3 bg-slate-750 border-t border-slate-600/50 mt-1">
                                <div className="grid grid-cols-2 gap-2 mt-2">
                                    <div>
                                        <label className="text-slate-500 block mb-1">LEDs</label>
                                        <input 
                                            type="number" 
                                            className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-200"
                                            value={f.ledCount}
                                            onChange={(e) => onUpdate(f.id, { ledCount: parseInt(e.target.value) || 1 })}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-slate-500 block mb-1">Rotation (°)</label>
                                        <div className="relative">
                                            <input 
                                                type="number" 
                                                className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-200"
                                                value={Math.round(f.rotation || 0)}
                                                onChange={(e) => onUpdate(f.id, { rotation: parseFloat(e.target.value) || 0 })}
                                            />
                                            <RotateCw size={10} className="absolute right-2 top-2 text-slate-600 pointer-events-none"/>
                                        </div>
                                    </div>
                                </div>
                                
                                <div className="grid grid-cols-2 gap-2">
                                    <div>
                                        <label className="text-slate-500 block mb-1">Universe</label>
                                        <input 
                                            type="number" 
                                            className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-200"
                                            value={f.universe}
                                            onChange={(e) => onUpdate(f.id, { universe: parseInt(e.target.value) || 0 })}
                                        />
                                    </div>
                                    <div>
                                        <label className="text-slate-500 block mb-1">Address</label>
                                        <input 
                                            type="number" 
                                            className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-slate-200"
                                            value={f.startAddress}
                                            onChange={(e) => onUpdate(f.id, { startAddress: parseInt(e.target.value) || 1 })}
                                        />
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 mt-2">
                                    <input 
                                        type="checkbox"
                                        id={`rev-${f.id}`}
                                        checked={f.reverse}
                                        onChange={(e) => onUpdate(f.id, { reverse: e.target.checked })}
                                        className="rounded border-slate-600 bg-slate-900"
                                    />
                                    <label htmlFor={`rev-${f.id}`} className="text-slate-400 select-none">Reverse Direction</label>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
      </div>
      
      <div className="p-3 bg-slate-950 text-xs text-slate-600 border-t border-slate-800 text-center">
        v1.1.0 &bull; ARTLUX
      </div>
    </div>
  );
};