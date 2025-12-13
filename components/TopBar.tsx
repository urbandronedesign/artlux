import React, { useRef } from 'react';
import { Play, Pause, Activity, Monitor, Wifi, Save, FolderOpen } from 'lucide-react';
import { Button } from './Button';
import { ViewMode } from '../types';

interface TopBarProps {
    isVideoPlaying: boolean;
    onTogglePlay: () => void;
    fps: number;
    artNetStatus: boolean;
    artNetIp: string;
    currentView: ViewMode;
    onChangeView: (view: ViewMode) => void;
    onSaveProject: () => void;
    onLoadProject: (file: File) => void;
}

export const TopBar: React.FC<TopBarProps> = ({ 
    isVideoPlaying, 
    onTogglePlay, 
    fps,
    artNetStatus,
    artNetIp,
    currentView,
    onChangeView,
    onSaveProject,
    onLoadProject
}) => {
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            onLoadProject(e.target.files[0]);
        }
        // Reset so same file can be selected again
        e.target.value = ''; 
    };

    return (
        <div className="h-10 bg-[#121212] border-b border-[#222] flex items-center justify-between px-3 select-none">
            {/* Left: Logo & Project Actions */}
            <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                    <div className="w-6 h-6 bg-gradient-to-br from-cyan-600 to-blue-700 rounded flex items-center justify-center font-bold text-xs text-white">A</div>
                    <span className="font-bold text-gray-300 text-sm tracking-wide">ARTLUX</span>
                </div>

                <div className="h-5 w-px bg-[#333] mx-1"></div>

                 {/* Save/Load Buttons */}
                 <div className="flex gap-1">
                    <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 px-2 text-gray-400 hover:text-white" 
                        onClick={onSaveProject} 
                        title="Save Project (JSON)"
                    >
                        <Save size={14} />
                    </Button>
                    <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 px-2 text-gray-400 hover:text-white" 
                        onClick={() => fileInputRef.current?.click()} 
                        title="Load Project (JSON)"
                    >
                        <FolderOpen size={14} />
                    </Button>
                    <input 
                        type="file" 
                        ref={fileInputRef} 
                        className="hidden" 
                        accept=".json"
                        onChange={handleFileChange}
                    />
                </div>
                
                <div className="h-5 w-px bg-[#333] mx-1"></div>
                
                <div className="flex gap-1">
                     <Button 
                        variant="ghost" 
                        size="sm" 
                        className={`h-6 text-xs px-2 rounded-sm border transition-all ${
                            currentView === ViewMode.MAPPING 
                            ? 'text-accent bg-accent/10 border-accent/20' 
                            : 'text-gray-500 border-transparent hover:text-gray-300'
                        }`}
                        onClick={() => onChangeView(ViewMode.MAPPING)}
                     >
                        <Monitor size={12} className="mr-1.5"/> Mapping
                     </Button>
                     <Button 
                        variant="ghost" 
                        size="sm" 
                        className={`h-6 text-xs px-2 rounded-sm border transition-all ${
                            currentView === ViewMode.MONITORING 
                            ? 'text-accent bg-accent/10 border-accent/20' 
                            : 'text-gray-500 border-transparent hover:text-gray-300'
                        }`}
                        onClick={() => onChangeView(ViewMode.MONITORING)}
                     >
                        <Activity size={12} className="mr-1.5"/> Monitoring
                     </Button>
                </div>
            </div>

            {/* Center: Transport */}
            <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#0a0a0a] rounded p-0.5 border border-[#222]">
                <button 
                    onClick={onTogglePlay}
                    className={`p-1 rounded w-8 flex items-center justify-center transition-colors ${!isVideoPlaying ? 'bg-[#222] text-white' : 'text-gray-500 hover:text-white'}`}
                >
                    <Pause size={12} fill="currentColor" />
                </button>
                <button 
                    onClick={onTogglePlay}
                    className={`p-1 rounded w-8 flex items-center justify-center transition-colors ${isVideoPlaying ? 'bg-accent text-black' : 'text-gray-500 hover:text-white'}`}
                >
                    <Play size={12} fill="currentColor" />
                </button>
            </div>

            {/* Right: Status */}
            <div className="flex items-center gap-3 text-xs font-mono text-gray-400">
                <div className="flex items-center gap-1.5" title="Render FPS">
                    <Activity size={10} className="text-green-500" />
                    <span>{fps.toFixed(0)} FPS</span>
                </div>
                <div className="h-4 w-px bg-[#333]"></div>
                <div className="flex items-center gap-1.5" title={`Target: ${artNetIp}`}>
                    <Wifi size={10} className={artNetStatus ? "text-accent" : "text-gray-600"} />
                    <span className={artNetStatus ? "text-accent" : "text-gray-600"}>
                        {artNetStatus ? "LIVE" : "OFFLINE"}
                    </span>
                </div>
            </div>
        </div>
    );
}