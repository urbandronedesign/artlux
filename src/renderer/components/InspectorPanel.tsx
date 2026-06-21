import React, { useState, useEffect } from 'react';
import { Fixture, SourceType, AppSettings, RGBW, PixelSource, LedShape, ColorOrder, RGBWMode, Layout3DType } from '../types';
import { Monitor, Image as ImageIcon, Video, Map, ChevronDown, Cpu, Sparkles, Grid3x3, Network, Box } from 'lucide-react';
import { addStatusListener } from '../services/mockSocketService';
import { EFFECT_NAMES } from '../gpu/effects';
import { PALETTE_NAMES } from '../gpu/palettes';
import { effectivePosObj, effectiveRotObj, effectiveLayout } from '../services/led3dDefaults';

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

    // Load a WLED-style ledmap.json ({"map":[...]} or a bare array) -> physical->geometry order.
    const handleLedmapUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !selectedFixture) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const parsed = JSON.parse(ev.target?.result as string);
                const map: number[] = Array.isArray(parsed) ? parsed : parsed.map;
                if (Array.isArray(map)) onUpdateFixture(selectedFixture.id, { ledMap: map });
                else alert('Unrecognized ledmap format (expected an array or {"map":[...]})');
            } catch {
                alert('Failed to parse ledmap JSON');
            }
        };
        reader.readAsText(file);
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

                <PanelSection title="Effect" icon={<Sparkles size={12}/>}>
                    {/* Content source: media vs generated effect */}
                    <div className="grid grid-cols-2 gap-1">
                        {([PixelSource.MEDIA, PixelSource.EFFECT] as const).map((src) => {
                            const active = (selectedFixture.source ?? PixelSource.MEDIA) === src;
                            return (
                                <button
                                    key={src}
                                    onClick={() => onUpdateFixture(selectedFixture.id, { source: src })}
                                    className={`text-[10px] py-1.5 rounded border transition-all ${active ? 'bg-accent/10 border-accent text-accent' : 'bg-[#181818] border-[#222] text-gray-500 hover:bg-[#202020]'}`}
                                >
                                    {src === PixelSource.MEDIA ? 'Media' : 'Effect'}
                                </button>
                            );
                        })}
                    </div>

                    {(selectedFixture.source ?? PixelSource.MEDIA) === PixelSource.EFFECT && (
                        <div className="space-y-3 pt-1">
                            <div className="flex items-center justify-between text-xs gap-2">
                                <label className="text-gray-500 w-16 truncate">Effect</label>
                                <select
                                    value={selectedFixture.effectId ?? 0}
                                    onChange={(e) => onUpdateFixture(selectedFixture.id, { effectId: parseInt(e.target.value) })}
                                    className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                                >
                                    {EFFECT_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
                                </select>
                            </div>

                            <div className="flex items-center justify-between text-xs gap-2">
                                <label className="text-gray-500 w-16 truncate">Palette</label>
                                <select
                                    value={selectedFixture.paletteId ?? 0}
                                    onChange={(e) => onUpdateFixture(selectedFixture.id, { paletteId: parseInt(e.target.value) })}
                                    className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                                >
                                    {PALETTE_NAMES.map((name, i) => <option key={i} value={i}>{name}</option>)}
                                </select>
                            </div>

                            <div className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                    <label className="text-gray-500">Speed</label>
                                    <span className="text-gray-400 font-mono text-[10px]">{Math.round((selectedFixture.speed ?? 0.5) * 100)}%</span>
                                </div>
                                <input type="range" min={0} max={1} step={0.01}
                                    value={selectedFixture.speed ?? 0.5}
                                    onChange={(e) => onUpdateFixture(selectedFixture.id, { speed: parseFloat(e.target.value) })}
                                    className="w-full"
                                />
                            </div>

                            <div className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                    <label className="text-gray-500">Intensity</label>
                                    <span className="text-gray-400 font-mono text-[10px]">{Math.round((selectedFixture.intensity ?? 0.5) * 100)}%</span>
                                </div>
                                <input type="range" min={0} max={1} step={0.01}
                                    value={selectedFixture.intensity ?? 0.5}
                                    onChange={(e) => onUpdateFixture(selectedFixture.id, { intensity: parseFloat(e.target.value) })}
                                    className="w-full"
                                />
                            </div>
                        </div>
                    )}
                </PanelSection>

                <PanelSection title="2D / Output" icon={<Grid3x3 size={12}/>}>
                    {/* Shape: line vs matrix */}
                    <div className="grid grid-cols-2 gap-1">
                        {([LedShape.LINE, LedShape.MATRIX] as const).map((sh) => {
                            const active = (selectedFixture.shape ?? LedShape.LINE) === sh;
                            return (
                                <button
                                    key={sh}
                                    onClick={() => onUpdateFixture(selectedFixture.id, { shape: sh })}
                                    className={`text-[10px] py-1.5 rounded border transition-all ${active ? 'bg-accent/10 border-accent text-accent' : 'bg-[#181818] border-[#222] text-gray-500 hover:bg-[#202020]'}`}
                                >
                                    {sh === LedShape.LINE ? 'Line' : 'Matrix'}
                                </button>
                            );
                        })}
                    </div>

                    {(selectedFixture.shape ?? LedShape.LINE) === LedShape.MATRIX && (
                        <div className="space-y-2 pt-1">
                            <NumberInput label="Cols" value={selectedFixture.matrixWidth ?? 8} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { matrixWidth: Math.max(1, v) })} />
                            <NumberInput label="Rows" value={selectedFixture.matrixHeight ?? 8} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { matrixHeight: Math.max(1, v) })} />
                            <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-500">Serpentine</span>
                                <input type="checkbox" checked={selectedFixture.serpentine ?? false}
                                    onChange={(e) => onUpdateFixture(selectedFixture.id, { serpentine: e.target.checked })}
                                    className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0" />
                            </div>
                        </div>
                    )}

                    <div className="flex items-center justify-between text-xs gap-2 pt-1">
                        <label className="text-gray-500 w-16 truncate">Color Order</label>
                        <select
                            value={selectedFixture.colorOrder ?? ColorOrder.RGB}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { colorOrder: e.target.value as ColorOrder })}
                            className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                        >
                            {Object.values(ColorOrder).map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                    </div>

                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-gray-500 w-16 truncate">Channels</label>
                        <select
                            value={selectedFixture.channelsPerPixel ?? 4}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { channelsPerPixel: parseInt(e.target.value) as 3 | 4 })}
                            className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                        >
                            <option value={3}>RGB (3)</option>
                            <option value={4}>RGBW (4)</option>
                        </select>
                    </div>

                    {(selectedFixture.channelsPerPixel ?? 4) === 4 && (
                        <div className="flex items-center justify-between text-xs gap-2">
                            <label className="text-gray-500 w-16 truncate">White</label>
                            <select
                                value={selectedFixture.rgbwMode ?? RGBWMode.SUBTRACT}
                                onChange={(e) => onUpdateFixture(selectedFixture.id, { rgbwMode: e.target.value as RGBWMode })}
                                className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                            >
                                <option value={RGBWMode.SUBTRACT}>Subtract min</option>
                                <option value={RGBWMode.NONE}>None</option>
                            </select>
                        </div>
                    )}

                    <label className="flex items-center justify-center gap-2 text-[10px] text-gray-400 bg-[#1a1a1a] hover:bg-[#202020] border border-[#333] rounded py-1.5 cursor-pointer mt-1">
                        <input type="file" accept=".json,application/json" className="hidden" onChange={handleLedmapUpload} />
                        {selectedFixture.ledMap ? `Ledmap: ${selectedFixture.ledMap.length} pts` : 'Load ledmap.json'}
                    </label>
                </PanelSection>

                <PanelSection title="Routing" icon={<Network size={12}/>}>
                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-gray-500 w-16 truncate">Protocol</label>
                        <select
                            value={selectedFixture.output?.protocol ?? ''}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, protocol: (e.target.value || undefined) as ('artnet' | 'sacn' | undefined) } })}
                            className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                        >
                            <option value="">Default ({settings.protocol})</option>
                            <option value="artnet">Art-Net</option>
                            <option value="sacn">sACN (E1.31)</option>
                        </select>
                    </div>
                    {(selectedFixture.output?.protocol ?? settings.protocol) === 'sacn' && (
                        <NumberInput label="Priority" value={selectedFixture.output?.priority ?? 100} step={1}
                            onChange={(v) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, priority: Math.max(0, Math.min(200, Math.round(v))) } })} />
                    )}
                    <div className="flex items-center justify-between text-xs gap-2">
                        <label className="text-gray-500 w-16 truncate">Target IP</label>
                        <input
                            type="text"
                            value={selectedFixture.output?.ip ?? ''}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, ip: e.target.value || undefined } })}
                            placeholder={settings.artNetIp + ' (default)'}
                            className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-right text-gray-300 focus:border-accent focus:outline-none font-mono"
                        />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500">Broadcast (override)</span>
                        <input type="checkbox" checked={selectedFixture.output?.broadcast ?? false}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, broadcast: e.target.checked } })}
                            className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0" />
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500" title="Skip universes whose data is unchanged">Sparse output</span>
                        <input type="checkbox" checked={selectedFixture.output?.sparse ?? false}
                            onChange={(e) => onUpdateFixture(selectedFixture.id, { output: { ...selectedFixture.output, sparse: e.target.checked } })}
                            className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0" />
                    </div>
                    <div className="text-[9px] text-gray-600 font-mono">
                        Blank IP → global target. Each fixture can address its own controller.
                    </div>
                </PanelSection>

                {(() => {
                    const p = effectivePosObj(selectedFixture);
                    const rotDeg = effectiveRotObj(selectedFixture);
                    const L = effectiveLayout(selectedFixture);
                    const setPos = (k: 'x' | 'y' | 'z', v: number) =>
                        onUpdateFixture(selectedFixture.id, { position3D: { x: p.x, y: p.y, z: p.z, [k]: v } });
                    const setRot = (k: 'pitch' | 'yaw' | 'roll', v: number) =>
                        onUpdateFixture(selectedFixture.id, { rotation3D: { ...rotDeg, [k]: v } });
                    const setLayout = (patch: Partial<typeof L>) =>
                        onUpdateFixture(selectedFixture.id, { layout3D: { ...L, ...patch } });
                    return (
                        <PanelSection title="3D Layout" icon={<Box size={12}/>}>
                            <div className="text-[9px] text-gray-600 uppercase tracking-wider">Position (m)</div>
                            <NumberInput label="X" value={+p.x.toFixed(3)} step={0.05} onChange={(v) => setPos('x', v)} />
                            <NumberInput label="Y" value={+p.y.toFixed(3)} step={0.05} onChange={(v) => setPos('y', v)} />
                            <NumberInput label="Z" value={+p.z.toFixed(3)} step={0.05} onChange={(v) => setPos('z', v)} />
                            <div className="text-[9px] text-gray-600 uppercase tracking-wider pt-1">Rotation (°)</div>
                            <NumberInput label="Pitch" value={+rotDeg.pitch.toFixed(1)} step={1} onChange={(v) => setRot('pitch', v)} />
                            <NumberInput label="Yaw" value={+rotDeg.yaw.toFixed(1)} step={1} onChange={(v) => setRot('yaw', v)} />
                            <NumberInput label="Roll" value={+rotDeg.roll.toFixed(1)} step={1} onChange={(v) => setRot('roll', v)} />

                            <div className="flex items-center justify-between text-xs gap-2 pt-1">
                                <label className="text-gray-500 w-16 truncate">Layout</label>
                                <select
                                    value={L.type}
                                    onChange={(e) => setLayout({ type: e.target.value as Layout3DType })}
                                    className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                                >
                                    <option value="line">Line</option>
                                    <option value="matrix">Matrix</option>
                                    <option value="arc">Arc</option>
                                </select>
                            </div>
                            {L.type !== 'arc' && (
                                <NumberInput label="Spacing" value={+L.ledSpacing.toFixed(4)} step={0.001} onChange={(v) => setLayout({ ledSpacing: Math.max(0.001, v) })} />
                            )}
                            {L.type === 'matrix' && (
                                <>
                                    <NumberInput label="Cols" value={L.matrixCols} step={1} onChange={(v) => setLayout({ matrixCols: Math.max(1, Math.round(v)) })} />
                                    <NumberInput label="Rows" value={L.matrixRows} step={1} onChange={(v) => setLayout({ matrixRows: Math.max(1, Math.round(v)) })} />
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-gray-500">Serpentine</span>
                                        <input type="checkbox" checked={L.serpentine}
                                            onChange={(e) => setLayout({ serpentine: e.target.checked })}
                                            className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0" />
                                    </div>
                                </>
                            )}
                            {L.type === 'arc' && (
                                <>
                                    <NumberInput label="Radius" value={+L.arcRadius.toFixed(3)} step={0.05} onChange={(v) => setLayout({ arcRadius: Math.max(0.01, v) })} />
                                    <NumberInput label="Angle" value={L.arcAngle} step={5} onChange={(v) => setLayout({ arcAngle: v })} />
                                </>
                            )}
                        </PanelSection>
                    );
                })()}
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
                             <div className="flex items-center justify-between text-xs gap-2">
                                <label className="text-gray-500 w-16 truncate">Protocol</label>
                                <select
                                    value={settings.protocol}
                                    onChange={(e) => onUpdateSettings({...settings, protocol: e.target.value as AppSettings['protocol']})}
                                    className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-gray-300 focus:border-accent focus:outline-none"
                                >
                                    <option value="artnet">Art-Net</option>
                                    <option value="sacn">sACN (E1.31)</option>
                                </select>
                             </div>
                             <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400 font-medium">Output Enabled</span>
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

                             <div className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                    <label className="text-gray-500">Gamma</label>
                                    <span className="text-gray-400 font-mono text-[10px]">{(settings.gamma ?? 1).toFixed(2)}</span>
                                </div>
                                <input type="range" min={1} max={3} step={0.05}
                                    value={settings.gamma ?? 1}
                                    onChange={(e) => onUpdateSettings({...settings, gamma: parseFloat(e.target.value)})}
                                    className="w-full"
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