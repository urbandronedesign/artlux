import React, { useState, useEffect } from 'react';
import { Fixture, SourceType, AppSettings, RGBW } from '../types';
import { Monitor, Image as ImageIcon, Video, Layers, Type, Map, Crosshair, ChevronDown, Cpu, RefreshCw, Download, Globe } from 'lucide-react';
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

    const handleDownloadBridge = () => {
        // Script with verbose logging for localhost debugging
        const scriptContent = `
const WebSocket = require('ws');
const dgram = require('dgram');

const WS_PORT = 8080;
const wss = new WebSocket.Server({ port: WS_PORT });
const udpSocket = dgram.createSocket('udp4');

// Enable broadcast to allow local discovery if needed
udpSocket.bind(() => {
    udpSocket.setBroadcast(true);
});

console.log('ARTLUX Bridge running on ws://localhost:' + WS_PORT);
console.log('Waiting for browser connection...');

wss.on('connection', ws => {
    console.log('Browser connected!');
    
    ws.on('message', message => {
        try {
            const payload = JSON.parse(message);
            if (payload.type === 'broadcast-artnet' && payload.data && payload.host && payload.port) {
                const buffer = Buffer.from(payload.data);
                
                udpSocket.send(buffer, payload.port, payload.host, (err) => {
                    if (err) {
                        console.error('UDP Send Error:', err);
                    } else {
                        // Verbose logging for verification
                        process.stdout.write(\`\\rSent \${buffer.length} bytes to \${payload.host}:\${payload.port} (Seq: \${payload.data[12]})\`);
                    }
                });
            }
        } catch (e) {
            console.error('Invalid Message:', e.message);
        }
    });

    ws.on('close', () => console.log('\\nBrowser disconnected'));
});

udpSocket.on('error', (err) => {
    console.error(\`\\nUDP Error: \${err.stack}\`);
    udpSocket.close();
});
`;
        const blob = new Blob([scriptContent.trim()], { type: 'text/javascript' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'artlux-bridge.js';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="w-64 bg-[#121212] border-r border-[#222] flex flex-col h-full overflow-y-auto">
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

            {/* Transform Section */}
            {selectedFixture ? (
                <>
                <PanelSection title="Transform" icon={<Crosshair size={12}/>}>
                    <div className="space-y-2">
                        <div className="flex gap-2">
                            <NumberInput label="X" value={Math.round(selectedFixture.x * 1000)/1000} step={0.01} onChange={(v) => onUpdateFixture(selectedFixture.id, { x: v })} />
                            <NumberInput label="Y" value={Math.round(selectedFixture.y * 1000)/1000} step={0.01} onChange={(v) => onUpdateFixture(selectedFixture.id, { y: v })} />
                        </div>
                        <div className="flex gap-2">
                            <NumberInput label="W" value={Math.round(selectedFixture.width * 1000)/1000} step={0.01} onChange={(v) => onUpdateFixture(selectedFixture.id, { width: v })} />
                            <NumberInput label="H" value={Math.round(selectedFixture.height * 1000)/1000} step={0.01} onChange={(v) => onUpdateFixture(selectedFixture.id, { height: v })} />
                        </div>
                        <NumberInput label="Rotation" value={Math.round(selectedFixture.rotation || 0)} step={1} onChange={(v) => onUpdateFixture(selectedFixture.id, { rotation: v })} />
                    </div>
                </PanelSection>

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

                        {/* Bridge Config */}
                        <div className="border-t border-[#222] pt-2 space-y-2">
                             <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-400 font-medium">WebSocket Bridge</span>
                                 <div className="flex items-center gap-2">
                                    <input 
                                        type="checkbox"
                                        checked={settings.useWsBridge}
                                        onChange={(e) => onUpdateSettings({...settings, useWsBridge: e.target.checked})}
                                        className="bg-[#0a0a0a] border-[#333] rounded text-accent focus:ring-0"
                                        title="Toggle WebSocket Bridge"
                                    />
                                    {/* Status Indicator */}
                                    <div className={`w-2 h-2 rounded-full transition-colors ${
                                        !settings.useWsBridge ? 'bg-gray-700' :
                                        isBridgeConnected ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]' : 'bg-red-500 animate-pulse'
                                    }`}></div>
                                 </div>
                             </div>

                             {settings.useWsBridge && (
                                <div className="flex items-center gap-2">
                                    <Globe size={12} className="text-gray-600" />
                                    <input 
                                        type="text" 
                                        value={settings.wsBridgeUrl}
                                        onChange={(e) => onUpdateSettings({...settings, wsBridgeUrl: e.target.value})}
                                        className="flex-1 bg-[#0a0a0a] border border-[#222] rounded px-1.5 py-1 text-xs text-gray-300 font-mono focus:border-accent focus:outline-none"
                                        placeholder="ws://localhost:8080"
                                    />
                                </div>
                             )}
                             
                             {settings.useWsBridge && !isBridgeConnected && (
                                 <div className="text-[9px] text-red-400 bg-red-900/10 p-1.5 rounded border border-red-900/30 flex items-center justify-center gap-1">
                                    <RefreshCw size={10} className="animate-spin" />
                                    Attempting to connect...
                                 </div>
                             )}
                        </div>

                        {/* Download Section */}
                        <button 
                            onClick={handleDownloadBridge}
                            className="w-full flex flex-col items-center justify-center gap-1 bg-[#1a1a1a] hover:bg-[#202020] active:bg-[#151515] border border-[#333] hover:border-gray-600 text-gray-300 text-xs py-2 rounded transition-all group"
                        >
                            <div className="flex items-center gap-2">
                                <Download size={12} className="text-accent group-hover:scale-110 transition-transform" />
                                <span className="font-medium">Download Bridge Script</span>
                            </div>
                            <span className="text-[9px] text-gray-600 font-mono">node artlux-bridge.js</span>
                        </button>

                     </div>
                </PanelSection>
             </div>
        </div>
    );
};