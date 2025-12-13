import React from 'react';
import { AppSettings, SourceType } from '../types';
import { Button } from './Button';
import { Monitor, Image as ImageIcon, Video, Wifi, Play, Pause, Square, Download, Code } from 'lucide-react';

interface SettingsPanelProps {
  settings: AppSettings;
  onUpdateSettings: (s: AppSettings) => void;
  sourceType: SourceType;
  onSetSource: (type: SourceType, url: string | null) => void;
  isVideoPlaying: boolean;
  onToggleVideoPlay: () => void;
  onStopVideo: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  settings,
  onUpdateSettings,
  sourceType,
  onSetSource,
  isVideoPlaying,
  onToggleVideoPlay,
  onStopVideo
}) => {
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, type: SourceType) => {
    const file = e.target.files?.[0];
    if (file) {
      const url = URL.createObjectURL(file);
      onSetSource(type, url);
    }
  };

  const handleDownloadBridge = () => {
      const scriptContent = `
const WebSocket = require('ws');
const dgram = require('dgram');

const WS_PORT = 8080;
const wss = new WebSocket.Server({ port: WS_PORT });
const udpSocket = dgram.createSocket('udp4');

console.log('ARTLUX Bridge running on ws://localhost:' + WS_PORT);

wss.on('connection', ws => {
    console.log('Client connected');
    
    ws.on('message', message => {
        try {
            const payload = JSON.parse(message);
            if (payload.type === 'broadcast-artnet' && payload.data && payload.host && payload.port) {
                const buffer = Buffer.from(payload.data);
                udpSocket.send(buffer, payload.port, payload.host, (err) => {
                    if (err) console.error('UDP Send Error:', err);
                });
            }
        } catch (e) {
            console.error('Invalid Message:', e.message);
        }
    });

    ws.on('close', () => console.log('Client disconnected'));
});

udpSocket.on('error', (err) => {
    console.error(\`UDP Error: \${err.stack}\`);
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
    <div className="h-48 bg-slate-800 border-t border-slate-700 flex text-slate-200">
      
      {/* Source Selection */}
      <div className="w-1/3 p-4 border-r border-slate-700 flex flex-col gap-2">
        <div className="flex justify-between items-center mb-1">
             <h3 className="text-xs font-bold uppercase text-slate-500">Input Source</h3>
        </div>
        
        <div className="grid grid-cols-2 gap-2">
           <Button 
             variant={sourceType === SourceType.CAMERA ? 'primary' : 'secondary'} 
             size="sm"
             onClick={() => onSetSource(SourceType.CAMERA, null)}
             icon={<Video size={14}/>}
            >
              Camera
           </Button>
           <div className="relative">
             <input type="file" accept="video/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={(e) => handleFileUpload(e, SourceType.VIDEO)} />
             <Button variant={sourceType === SourceType.VIDEO ? 'primary' : 'secondary'} size="sm" className="w-full" icon={<Monitor size={14}/>}>
               Video File
             </Button>
           </div>
           <div className="relative">
             <input type="file" accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={(e) => handleFileUpload(e, SourceType.IMAGE)} />
             <Button variant={sourceType === SourceType.IMAGE ? 'primary' : 'secondary'} size="sm" className="w-full" icon={<ImageIcon size={14}/>}>
               Image
             </Button>
           </div>
           <Button variant="ghost" size="sm" onClick={() => onSetSource(SourceType.NONE, null)}>
               Clear
           </Button>
        </div>

        {/* Video Transport Controls */}
        {sourceType === SourceType.VIDEO && (
            <div className="mt-2 pt-2 border-t border-slate-700 flex gap-2">
                <Button 
                    variant={isVideoPlaying ? "secondary" : "primary"} 
                    size="sm" 
                    className="flex-1"
                    onClick={onToggleVideoPlay}
                >
                    {isVideoPlaying ? <><Pause size={14} className="mr-1"/> Pause</> : <><Play size={14} className="mr-1"/> Play</>}
                </Button>
                <Button 
                    variant="danger" 
                    size="sm"
                    onClick={onStopVideo}
                    title="Stop and Rewind"
                >
                    <Square size={14} fill="currentColor" />
                </Button>
            </div>
        )}
      </div>

      {/* Network Settings */}
      <div className="w-1/3 p-4 border-r border-slate-700 flex flex-col gap-3">
        <h3 className="text-xs font-bold uppercase text-slate-500 mb-1 flex items-center gap-2">
            <Wifi size={12}/> Network (ArtNet)
        </h3>
        <div className="grid grid-cols-2 gap-3">
            <div>
                <label className="block text-xs text-slate-400 mb-1">Target IP</label>
                <input 
                    type="text" 
                    value={settings.artNetIp}
                    onChange={(e) => onUpdateSettings({...settings, artNetIp: e.target.value})}
                    className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono"
                    placeholder="2.0.0.10"
                />
            </div>
            <div>
                <label className="block text-xs text-slate-400 mb-1">Port</label>
                <input 
                    type="number" 
                    value={settings.artNetPort}
                    onChange={(e) => onUpdateSettings({...settings, artNetPort: parseInt(e.target.value)})}
                    className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono"
                    placeholder="6454"
                />
            </div>
        </div>
        <div className="bg-slate-900/50 p-2 rounded border border-slate-600/30">
            <div className="flex justify-between items-center mb-1">
                 <span className="text-[10px] text-gray-400 font-bold uppercase">Required Backend</span>
            </div>
            <Button 
                variant="ghost" 
                size="sm" 
                className="w-full h-6 text-[10px] border border-slate-600 text-cyan-400 hover:text-cyan-300 hover:border-cyan-500"
                onClick={handleDownloadBridge}
                icon={<Download size={10} />}
            >
                Download Bridge Script
            </Button>
            <div className="text-[9px] text-gray-500 mt-1">
                Run with: <span className="font-mono text-gray-400">node artlux-bridge.js</span>
            </div>
        </div>
      </div>

      {/* Bridge Settings */}
      <div className="w-1/3 p-4 flex flex-col gap-3">
        <h3 className="text-xs font-bold uppercase text-slate-500 mb-1">Output Bridge</h3>
        <div>
            <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input 
                    type="checkbox" 
                    checked={settings.useWsBridge}
                    onChange={(e) => onUpdateSettings({...settings, useWsBridge: e.target.checked})}
                    className="rounded bg-slate-900 border-slate-600 text-blue-500 focus:ring-offset-slate-800"
                />
                <span className="text-sm">Enable WebSocket Bridge</span>
            </label>
            <input 
                type="text" 
                disabled={!settings.useWsBridge}
                value={settings.wsBridgeUrl}
                onChange={(e) => onUpdateSettings({...settings, wsBridgeUrl: e.target.value})}
                className="w-full bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs font-mono disabled:opacity-50"
                placeholder="ws://localhost:8080"
            />
        </div>
        <div className="mt-auto">
             <div className={`text-xs flex items-center gap-2 ${settings.useWsBridge ? 'text-green-500' : 'text-slate-500'}`}>
                <div className={`w-2 h-2 rounded-full ${settings.useWsBridge ? 'bg-green-500 animate-pulse' : 'bg-slate-600'}`}></div>
                {settings.useWsBridge ? "Ready to transmit" : "Output Disabled"}
             </div>
        </div>
      </div>

    </div>
  );
};