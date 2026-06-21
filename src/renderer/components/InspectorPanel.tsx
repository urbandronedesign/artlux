import React, { useState, useEffect } from 'react';
import { Fixture, SourceType, AppSettings, RGBW } from '../types';
import { Monitor, Image as ImageIcon, Video, Map, ChevronDown, Cpu } from 'lucide-react';
import { addStatusListener } from '../services/mockSocketService';

interface InspectorPanelProps {
    sourceType: SourceType;
    onSetSource: (type: SourceType, url: string | null) => void;
    selectedFixture: Fixture | null;
    onUpdateFixture: (id: string, updates: Partial<Fixture>) => void;
    settings: AppSettings;
    onUpdateSettings: (s: AppSettings) => void;
}

const PanelSection: React.FC<{ title: string; children: React.ReactNode; icon?: React.ReactNode }> = ({ title, children, icon }) => (
    <div className="border-b border-[#222]">
        <div className="px-3 py-2 bg-[#161616] flex items-center justify-between cursor-pointer hover:bg-[#1a1a1a]">
            <div className="flex items-center gap-2 text-xs font-bold text-gray-400 uppercase tracking-wider">
                {icon && <span className="text-gray-500">{icon}</span>}
                {title}
            </div>
            <ChevronDown size={12} className="text-gray-600" />
        </div>
        <div className="p-3 bg-[#121212] space-y-3">
            {children}
        </div>
    </div>
);

const NumberInput: React.FC<{ label: string; value: number; onChange: (v: number) => void; step?: number }> = ({ label, value, onChange, step = 1 }) => (
    <div className="flex items-center justify-between text-xs gap-2">
        <label className="text-gray-500 cursor-e-resize w-16 truncate">{label}</label>
        <input 
            type="number"
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-right text-gray-300 focus:border-accent focus:outline-none font-mono"
        />
    </div>
);

export const InspectorPanel: React.FC<InspectorPanelProps> = ({
    sourceType,
    onSetSource,
    selectedFixture,
    onUpdateFixture,
    settings,
    onUpdateSettings
}) => {
    const [isBridgeConnected, setIsBridgeConnected] = useState(false);

    useEffect(() => {
        return addStatusListener(setIsBridgeConnected);
    }, []);

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: SourceType) => {
        const file = e.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            onSetSource(type, url);
        }
    };

    return (
        <div className="flex flex-col h-full bg-[#121212] border-r border-[#222] overflow-y-auto">
            {/* Input Source Section */}
            <PanelSection title="Input Source" icon={<Monitor size={12}/>}>
                <div className="grid grid-cols-3 gap-1">
                    <button 
                        onClick={() => onSetSource(SourceType.CAMERA, null)}
                        className={`flex flex-col items-center justify-center p-2 rounded border transition-all ${sourceType === SourceType.CAMERA ? 'bg-accent/10 border-accent text-accent' : 'bg-[#181818] border-[#222] text-gray-500 hover:bg-[#202020]'}`}
                    >
                        <Video size={16} className="mb-1"/>
                        <span className="text-[9px]">Camera</span>
                    </button>
                    <label className={`relative cursor-pointer flex flex-col items-center justify-center p-2 rounded border transition-all ${sourceType === SourceType.VIDEO ? 'bg-accent/10 border-accent text-accent' : 'bg-[#181818] border-[#222] text-gray-500 hover:bg-[#202020]'}`}>
                        <input type="file" accept="video/*" className="hidden" onChange={(e) => handleFileUpload(e, SourceType.VIDEO)} />
                        <Monitor size={16} className="mb-1"/>
                        <span className="text-[9px]">Video</span>
                    </label>
                    <label className={`relative cursor-pointer flex flex-col items-center justify-center p-2 rounded border transition-all ${sourceType === SourceType.IMAGE ? 'bg-accent/10 border-accent text-accent' : 'bg-[#181818] border-[#222] text-gray-500 hover:bg-[#202020]'}`}>
                         <input type="file" accept="image/*" className="hidden" onChange={(e) => handleFileUpload(e, SourceType.IMAGE)} />
                        <ImageIcon size={16} className="mb-1"/>
                        <span className="text-[9px]">Image</span>
                    </label>
                </div>
            </PanelSection>

            {/* Transform section removed as requested to expose editing in viewport only */}

            {selectedFixture ? (
                <>
                <PanelSection title="Mapping" icon={<Map size={12}/>}>
                    <NumberInput label="LED Count" value={selectedFixture.ledCount} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { ledCount: Math.max(1, v) })} />
                    <NumberInput label="Universe" value={selectedFixture.universe} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { universe: Math.max(0, v) })} />
                    <NumberInput label="Start Addr" value={selectedFixture.startAddress} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { startAddress: Math.max(1, v) })} />
                    
                    <div className="flex items-center justify-between mt-2 pt-2 border-t border-[#222]">
                        <span className="text-xs text-gray-500">Reverse Direction</span>
                        <input 
                            type="checkbox" 
                            checked={selectedFixture.reverse} 
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { reverse: e.target.checked })}
                            className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0"
                        />
                    </div>
                </PanelSection>
                </>
            ) : (
                <div className="p-4 text-center text-gray-600 text-xs italic mt-10">
                    Select a fixture to edit properties
                </div>
            )}
            
            {/* Global Settings */}
             <div className="mt-auto border-t border-[#222]">
                <PanelSection title="Output Config" icon={<Cpu size={12}/>}>
                     <div className="space-y-3">
                        {/* ArtNet Target */}
                        <div className="space-y-1">
                            <div className="flex items-center justify-between text-xs gap-2">
                                <label className="text-gray-500 w-16 truncate">Target IP</label>
                                <input 
                                    type="text" 
                                    value={settings.artNetIp}
                                    onChange={(e) => onUpdateSettings({...settings, artNetIp: e.target.value})}
                                    className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-right text-gray-300 focus:border-accent focus:outline-none font-mono"
                                    placeholder="2.0.0.1"
                                />
                            </div>
                            
                            <NumberInput 
                                label="Port" 
                                value={settings.artNetPort} 
                                onChange={(v) => onUpdateSettings({...settings, artNetPort: v})} 
                                step={1}
                            />
                        </div>

                        {/* Native Output Config */}
                        <div className="border-t border-[#222] pt-2 space-y-2">
                             <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400 font-medium">Art-Net Output</span>
                                 <div className="flex items-center gap-2">
                                    <input
                                        type="checkbox"
                                        checked={settings.outputEnabled}
                                        onChange={(e) => onUpdateSettings({...settings, outputEnabled: e.target.checked})}
                                        className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0"
                                        title="Toggle Art-Net output"
                                    />
                                    {/* Status Indicator */}
                                    <div className={`w-2 h-2 rounded-full transition-colors ${
                                        !settings.outputEnabled ? 'bg-gray-700' :
                                        isBridgeConnected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-red-500 animate-pulse'
                                    }`}></div>
                                 </div>
                             </div>

                             <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-500">Broadcast</span>
                                <input
                                    type="checkbox"
                                    checked={settings.broadcast}
                                    onChange={(e) => onUpdateSettings({...settings, broadcast: e.target.checked})}
                                    className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0"
                                    title="Send as UDP broadcast instead of unicast"
                                />
                             </div>

                             <div className="text-[9px] text-gray-600 font-mono">
                                Native UDP — no bridge required
                             </div>
                        </div>

                     </div>
                </PanelSection>
             </div>
        </div>
    );
}